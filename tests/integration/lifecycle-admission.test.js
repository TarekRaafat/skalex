import { describe, test, expect } from "vitest";
import Skalex from "../../src/index.js";
import MemoryAdapter from "../helpers/MemoryAdapter.js";

const barrier = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const setup = async () => {
  const adapter = new MemoryAdapter();
  const db = new Skalex({ adapter, logger: () => {} });
  const col = db.useCollection("items");
  await col.insertOne({ _id: "one", value: 0 }, { save: true });
  return { db, col, adapter };
};

describe("database lifecycle and collection identity", () => {
  test.each([false, true])("independent saves reject locked state, save all %s", async all => {
    const { db, col, adapter } = await setup();
    const ready = barrier(), release = barrier();
    const failure = new Error("abort");
    const tx = db.transaction(async handle => {
      await handle.useCollection("items").updateOne({}, { value: 1 });
      ready.resolve();
      await release.promise;
      throw failure;
    }).catch(e => e);
    await ready.promise;
    try {
      await expect(db.saveData(all ? undefined : "items")).rejects.toMatchObject({ code: "ERR_SKALEX_TX_COLLECTION_LOCKED" });
    } finally { release.resolve(); }
    expect(await tx).toBe(failure);
    expect((await col.findOne({})).value).toBe(0);
    expect((await new Skalex({ adapter }).useCollection("items").findOne({})).value).toBe(0);
  });

  test("a queued save rechecks ownership before serialization", async () => {
    const { db, col, adapter } = await setup();
    const entered = barrier(), unblock = barrier();
    const write = adapter.write.bind(adapter);
    adapter.write = async (name, data) => {
      if (name === "other") { entered.resolve(); await unblock.promise; }
      return write(name, data);
    };
    await db.useCollection("other").insertOne({ value: 0 });
    const first = db.saveData("other");
    await entered.promise;
    const queued = db.saveData("items").catch(e => e);
    const ready = barrier(), release = barrier();
    const tx = db.transaction(async handle => {
      await handle.useCollection("items").updateOne({}, { value: 1 });
      ready.resolve();
      await release.promise;
      throw new Error("abort");
    }).catch(e => e);
    await ready.promise;
    unblock.resolve();
    await first;
    try { expect(await queued).toMatchObject({ code: "ERR_SKALEX_TX_COLLECTION_LOCKED" }); }
    finally { release.resolve(); await tx; }
    expect((await col.findOne({})).value).toBe(0);
    expect((await new Skalex({ adapter }).useCollection("items").findOne({})).value).toBe(0);
  });

  test("unlocked collections can still save during a transaction", async () => {
    const { db, adapter } = await setup();
    await db.transaction(async tx => {
      await tx.useCollection("items").updateOne({}, { value: 1 });
      await db.useCollection("other").insertOne({ value: 2 }, { save: true });
    });
    expect((await new Skalex({ adapter }).useCollection("other").findOne({})).value).toBe(2);
  });

  test.each(["disconnect", "loadData"])("%s rejects during a transaction without changing data", async op => {
    const { db, col } = await setup();
    await db.transaction(async tx => {
      await tx.useCollection("items").updateOne({}, { value: 1 });
      await expect(db[op]()).rejects.toMatchObject({ code: "ERR_SKALEX_TX_DIRECT_ACCESS" });
    });
    expect((await col.findOne({})).value).toBe(1);
  });

  test.each(["rename", "reset"])("%s cannot replace a locked store", async op => {
    const { db, col } = await setup();
    await db.transaction(async tx => {
      await tx.useCollection("items").updateOne({}, { value: 1 });
      const action = op === "rename" ? db.renameCollection("items", "other") : db.seed({ items: [] }, { reset: true });
      await expect(action).rejects.toMatchObject({ code: "ERR_SKALEX_TX_COLLECTION_LOCKED" });
      expect((await col.findOne({})).value).toBe(1);
    });
  });

  test.each(["findOne", "insertOne", "export"])("old handles reject %s after disconnect and reconnect", async op => {
    const { db, col } = await setup();
    await db.disconnect();
    await db.connect();
    await expect(col[op]({})).rejects.toMatchObject({ code: "ERR_SKALEX_VALIDATION_STALE_COLLECTION" });
    expect(await db.useCollection("items").count()).toBe(1);
  });

  test("a prepared write cannot resume into a disconnected store", async () => {
    const { db, col, adapter } = await setup();
    const entered = barrier(), release = barrier();
    db.use({ beforeInsert: async () => { entered.resolve(); await release.promise; } });
    const pending = col.insertOne({ _id: "late" }).catch(error => error);
    await entered.promise;
    await db.disconnect();
    release.resolve();
    expect(await pending).toMatchObject({ code: "ERR_SKALEX_VALIDATION_STALE_COLLECTION" });
    expect(await new Skalex({ adapter }).useCollection("items").count()).toBe(1);
  });

  test("stale subscriptions and memory operations reject", async () => {
    const { db, col } = await setup();
    const memory = db.useMemory("session");
    await db.disconnect();
    expect(() => col.watch(() => {})).toThrow(expect.objectContaining({ code: "ERR_SKALEX_VALIDATION_STALE_COLLECTION" }));
    await expect(memory.history()).rejects.toMatchObject({ code: "ERR_SKALEX_VALIDATION_STALE_COLLECTION" });
  });

  test("reset seeding preserves the tracked handle through reload and retirement", async () => {
    const { db, col } = await setup();
    await db.seed({ items: [{ _id: "replacement", value: 2 }] }, { reset: true });
    expect(db.useCollection("items")).toBe(col);
    await db.loadData();
    expect((await col.findOne({})).value).toBe(2);
    await db.disconnect();
    await expect(col.count()).rejects.toMatchObject({ code: "ERR_SKALEX_VALIDATION_STALE_COLLECTION" });
  });

  test("an ordinary observer of a rolled-back collection expires", async () => {
    const { db } = await setup();
    let observer;
    await expect(db.transaction(async tx => {
      await tx.useCollection("temporary").insertOne({ value: 1 });
      observer = db.useCollection("temporary");
      throw new Error("abort creation");
    })).rejects.toThrow("abort creation");
    await expect(observer.count()).rejects.toMatchObject({ code: "ERR_SKALEX_VALIDATION_STALE_COLLECTION" });
    expect(await db.useCollection("temporary").count()).toBe(0);
  });

  test("cached handles remain valid through explicit reload", async () => {
    const { db, col } = await setup();
    await db.loadData();
    await col.insertOne({ _id: "two" }, { save: true });
    expect(await db.useCollection("items").count()).toBe(2);
  });

  test("pre-connect definitions still apply to persisted data", async () => {
    const { adapter } = await setup();
    const db = new Skalex({ adapter });
    const col = db.createCollection("items", { schema: { value: "number" }, indexes: ["value"] });
    await db.connect();
    expect((await col.findOne({ value: 0 }))._id).toBe("one");
  });

  test("duplicate definitions reject without discarding data or handles", async () => {
    const { db, col } = await setup();
    expect(() => db.createCollection("items")).toThrow(expect.objectContaining({ code: "ERR_SKALEX_PERSISTENCE_COLLECTION_EXISTS" }));
    expect(db.useCollection("items")).toBe(col);
    expect(await col.count()).toBe(1);
  });

  test.each(["../outside", "a/b", "", "a".repeat(65)])("invalid rename %s has no effects", async name => {
    const { db, col, adapter } = await setup();
    await expect(db.renameCollection("items", name)).rejects.toMatchObject({ code: "ERR_SKALEX_VALIDATION_COLLECTION_NAME" });
    expect(await col.count()).toBe(1);
    expect(await adapter.list()).toEqual(["items"]);
  });

  test.each(["constructor", "toString", "__proto__"])("prototype-like name %s round trips", async name => {
    const adapter = new MemoryAdapter();
    const db = new Skalex({ adapter });
    const col = db.createCollection(name);
    await col.insertOne({ value: 7 }, { save: true });
    expect(db.useCollection(name)).toBe(col);
    expect(Object.hasOwn(db.inspect(), name)).toBe(true);
    expect(Object.hasOwn(db.dump(), name)).toBe(!name.startsWith("_"));
    await db.disconnect();
    const current = db.useCollection(name);
    expect((await current.findOne({})).value).toBe(7);
    await db.renameCollection(name, "renamed");
    expect((await current.findOne({})).value).toBe(7);
  });
});
