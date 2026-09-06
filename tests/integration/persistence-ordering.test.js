import { describe, expect, test } from "vitest";
import Skalex from "../../src/index.js";
import MemoryAdapter from "../helpers/MemoryAdapter.js";

const latch = () => {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
};
const turn = () => new Promise(resolve => setTimeout(resolve, 0));
async function setup() {
  const adapter = new MemoryAdapter();
  const db = new Skalex({ adapter, logger: () => {} });
  await db.connect();
  const col = db.useCollection("items");
  await col.insertOne({ _id: "x", value: 0 }, { save: true });
  return { db, col, adapter };
}
async function reload(adapter, name = "items") {
  const db = new Skalex({ adapter });
  await db.connect();
  return db.useCollection(name).findOne({ _id: "x" });
}

describe("ordinary saves and transaction commit ordering", () => {
  test.each(["one", "all", "mutation", "dirty"])("%s save cannot overwrite a later commit", async mode => {
    const { db, col, adapter } = await setup();
    const entered = latch(), release = latch(), prepared = latch();
    const write = adapter.write.bind(adapter), writeAll = adapter.writeAll.bind(adapter);
    const order = [];
    let pause = true;
    adapter.write = async (name, data) => {
      if (name === "items" && pause) {
        pause = false;
        entered.release();
        await release.promise;
        await write(name, data);
        order.push("old:end");
      } else await write(name, data);
    };
    adapter.writeAll = async entries => {
      order.push("batch:start");
      await writeAll(entries);
    };
    if (mode === "dirty") await col.updateOne({ _id: "x" }, { value: 0 });
    const saving = mode === "one" ? db.saveData("items")
      : mode === "all" ? db.saveData()
      : mode === "mutation" ? col.updateOne({ _id: "x" }, { value: 0 }, { save: true })
      : db._persistence.saveDirty(db.collections);
    await entered.promise;
    const committing = db.transaction(async tx => {
      await tx.useCollection("items").updateOne({ _id: "x" }, { value: 1 });
      prepared.release();
    });
    await prepared.promise;
    await turn();
    release.release();
    await Promise.all([saving, committing]);
    expect(order).toEqual(["old:end", "batch:start"]);
    expect((await reload(adapter)).value).toBe(1);
  });

  test("a failed older save does not block the queued commit", async () => {
    const { db, adapter } = await setup();
    const entered = latch(), release = latch(), prepared = latch();
    const write = adapter.write.bind(adapter);
    let pause = true;
    adapter.write = async (name, data) => {
      if (name === "items" && pause) {
        pause = false;
        entered.release();
        await release.promise;
        throw new Error("old write failed");
      }
      await write(name, data);
    };
    const saving = db.saveData("items").catch(error => error);
    await entered.promise;
    const committing = db.transaction(async tx => {
      await tx.useCollection("items").updateOne({ _id: "x" }, { value: 2 });
      prepared.release();
    });
    await prepared.promise;
    release.release();
    expect((await saving).message).toBe("old write failed");
    await committing;
    expect((await reload(adapter)).value).toBe(2);
  });

  test("ordinary writes wait for the batch sentinel clear", async () => {
    const { db, adapter } = await setup();
    const entered = latch(), release = latch();
    const write = adapter.write.bind(adapter);
    const order = [];
    let metaWrites = 0;
    adapter.write = async (name, data) => {
      if (name === "_meta" && ++metaWrites === 2) {
        entered.release();
        await release.promise;
        order.push("clear:end");
      }
      if (name === "other") order.push("ordinary");
      await write(name, data);
    };
    const committing = db.transaction(tx => tx.useCollection("items").updateOne({ _id: "x" }, { value: 1 }));
    await entered.promise;
    const saving = db.useCollection("other").insertOne({ _id: "x", value: 3 }, { save: true });
    await turn();
    release.release();
    await Promise.all([committing, saving]);
    expect(order).toEqual(["clear:end", "ordinary"]);
    expect((await reload(adapter, "other")).value).toBe(3);
  });

  test("a rejected batch releases the queue for ordinary saves", async () => {
    const { db, adapter } = await setup();
    const entered = latch(), release = latch();
    adapter.writeAll = async () => {
      entered.release();
      await release.promise;
      throw new Error("batch failed");
    };
    const committing = db.transaction(tx => tx.useCollection("items").updateOne({ _id: "x" }, { value: 1 })).catch(error => error);
    await entered.promise;
    const saving = db.useCollection("other").insertOne({ _id: "x", value: 3 }, { save: true });
    await turn();
    release.release();
    expect((await committing).code).toBe("ERR_SKALEX_PERSISTENCE_FLUSH_FAILED");
    await saving;
    expect((await reload(adapter, "other")).value).toBe(3);
    expect((await db.useCollection("items").findOne({ _id: "x" })).value).toBe(0);
  });

  test("coalesced callers wait for the latest serialized snapshot", async () => {
    const { db, col, adapter } = await setup();
    const entered = latch(), release = latch();
    const write = adapter.write.bind(adapter);
    let count = 0;
    adapter.write = async (name, data) => {
      if (name === "items" && ++count === 1) {
        entered.release();
        await release.promise;
      }
      await write(name, data);
    };
    const first = db.saveData("items");
    await entered.promise;
    await col.updateOne({ _id: "x" }, { value: 4 });
    const second = db.saveData("items"), third = db.saveData("items");
    release.release();
    await Promise.all([first, second, third]);
    expect(count).toBe(2);
    expect((await reload(adapter)).value).toBe(4);
  });

  test("a completed older snapshot does not clear a newer unsaved edit", async () => {
    const { db, col, adapter } = await setup();
    const entered = latch(), release = latch();
    const write = adapter.write.bind(adapter);
    let pause = true;
    adapter.write = async (name, data) => {
      if (name === "items" && pause) {
        pause = false;
        entered.release();
        await release.promise;
      }
      await write(name, data);
    };
    const saving = db.saveData("items");
    await entered.promise;
    await col.updateOne({ _id: "x" }, { value: 5 });
    release.release();
    await saving;
    await db._persistence.saveDirty(db.collections);
    expect((await reload(adapter)).value).toBe(5);
  });

  test("failed ordinary writes remain eligible for dirty-save retry", async () => {
    const { db, col, adapter } = await setup();
    await col.updateOne({ _id: "x" }, { value: 6 });
    adapter.throwOnWrite = true;
    await expect(db.saveData("items")).rejects.toThrow();
    adapter.throwOnWrite = false;
    await db._persistence.saveDirty(db.collections);
    expect((await reload(adapter)).value).toBe(6);
  });
});

test("queued saves serialize the current data when their turn begins", async () => {
  const { db, adapter } = await setup();
  const other = db.useCollection("other");
  await other.insertOne({ _id: "x", value: 0 });
  const entered = latch(), release = latch();
  const write = adapter.write.bind(adapter);
  let pause = true;
  adapter.write = async (name, data) => {
    if (name === "items" && pause) {
      pause = false;
      entered.release();
      await release.promise;
    }
    await write(name, data);
  };
  const first = db.saveData("items");
  await entered.promise;
  const second = db.saveData("other");
  await turn();
  await other.updateOne({ _id: "x" }, { value: 7 });
  release.release();
  await Promise.all([first, second]);
  expect((await reload(adapter, "other")).value).toBe(7);
});
