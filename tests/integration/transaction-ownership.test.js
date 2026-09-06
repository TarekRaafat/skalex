import { describe, expect, test } from "vitest";
import Skalex from "../../src/index.js";
import MemoryAdapter from "../helpers/MemoryAdapter.js";

function barrier() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
async function setup() {
  const adapter = new MemoryAdapter();
  const db = new Skalex({ adapter, autoSave: true });
  await db.connect();
  return { db, adapter };
}

describe("transaction ownership", () => {
  test("rejects a bare write while an awaited transaction hook is suspended", async () => {
    const { db } = await setup();
    const col = db.useCollection("items");
    const entered = barrier(), release = barrier();
    db.use({ beforeInsert: async ({ doc }) => {
      if (doc._id === "owned") { entered.resolve(); await release.promise; }
    } });
    const running = db.transaction(async tx => {
      await tx.useCollection("items").insertOne({ _id: "owned" });
    });
    await entered.promise;
    let error;
    try { await col.insertOne({ _id: "outside" }); } catch (e) { error = e; }
    release.resolve();
    await running;
    expect(error).toMatchObject({ code: "ERR_SKALEX_TX_COLLECTION_LOCKED" });
    expect((await col.find({})).docs.map(d => d._id)).toEqual(["owned"]);
  });

  test("rechecks the lock after a bare write's asynchronous hook", async () => {
    const { db } = await setup();
    const col = db.useCollection("items");
    const entered = barrier(), release = barrier();
    db.use({ beforeInsert: async ({ doc }) => {
      if (doc._id === "outside") { entered.resolve(); await release.promise; }
    } });
    const outside = col.insertOne({ _id: "outside" }).then(() => null, e => e);
    await entered.promise;
    await db.transaction(async tx => {
      await tx.useCollection("items").insertOne({ _id: "owned" });
      release.resolve();
      expect(await outside).toMatchObject({ code: "ERR_SKALEX_TX_COLLECTION_LOCKED" });
    });
    expect((await col.find({})).docs.map(d => d._id)).toEqual(["owned"]);
  });

  test("preserves independent creation, persistence and effects on rollback", async () => {
    const { db, adapter } = await setup();
    const events = [], hooks = [];
    db.watch(e => { if (e.collection === "outside") events.push(e.doc._id); });
    db.use({ afterInsert: ({ collection, doc }) => { if (collection === "outside") hooks.push(doc._id); } });
    const failure = new Error("rollback");
    await expect(db.transaction(async tx => {
      await tx.useCollection("owned").insertOne({ _id: "discard" });
      const outside = db.createCollection("outside", { changelog: true });
      await outside.insertOne({ _id: "keep" }, { session: "outside" });
      expect(events).toEqual(["keep"]);
      expect(hooks).toEqual(["keep"]);
      expect((await db.changelog().query("outside")).map(e => e.doc._id)).toEqual(["keep"]);
      throw failure;
    })).rejects.toBe(failure);
    expect(Object.keys(db.collections)).toContain("outside");
    expect(Object.keys(db.collections)).not.toContain("owned");
    expect((await db.useCollection("outside").findOne({ _id: "keep" }))._id).toBe("keep");
    const reopened = new Skalex({ adapter });
    await reopened.connect();
    expect((await reopened.useCollection("outside").find({})).docs.map(d => d._id)).toEqual(["keep"]);
    await reopened.disconnect();
    expect(db.sessionStats("outside").writes).toBe(1);
    expect(events).toEqual(["keep"]);
    expect(hooks).toEqual(["keep"]);
  });

  test("restores a collection created independently after transaction start", async () => {
    const { db } = await setup();
    const failure = new Error("rollback");
    await expect(db.transaction(async tx => {
      await db.useCollection("outside").insertOne({ _id: "keep" });
      await tx.useCollection("outside").insertOne({ _id: "discard" });
      throw failure;
    })).rejects.toBe(failure);
    expect(Object.keys(db.collections)).toContain("outside");
    expect((await db.useCollection("outside").find({})).docs.map(d => d._id)).toEqual(["keep"]);
  });

  test.each(["commit", "rollback"])("expires handles and captured functions after %s", async outcome => {
    const { db } = await setup();
    let col, insert, count, getCollection;
    const failure = new Error("rollback");
    const running = db.transaction(async tx => {
      getCollection = tx.useCollection;
      col = getCollection("items");
      insert = col.insertOne;
      count = col.count;
      await insert({ _id: "owned" });
      if (outcome === "rollback") throw failure;
    });
    if (outcome === "rollback") await expect(running).rejects.toBe(failure);
    else await running;
    for (const call of [
      () => col.insertOne({ _id: "stale" }),
      () => insert({ _id: "stale" }),
      () => count({}),
      () => getCollection("late"),
      () => col.findOne({}),
    ]) {
      let error;
      try { await call(); } catch (e) { error = e; }
      expect(error?.code).toMatch(/^ERR_SKALEX_TX_(STALE_PROXY|ABORTED)$/);
    }
    expect(Object.keys(db.collections)).not.toContain("late");
    await db.useCollection("items").insertOne({ _id: "fresh" });
    expect(await db.useCollection("items").findOne({ _id: "stale" })).toBeNull();
  });

  test("supports concurrent awaited owned writes and same-collection after-hook cascades", async () => {
    const { db } = await setup();
    const col = db.useCollection("items");
    db.use({ afterInsert: async ({ doc }) => {
      if (doc._id === "a") await col.insertOne({ _id: "cascade" });
    } });
    await db.transaction(async tx => {
      const owned = tx.useCollection("items");
      await Promise.all([owned.insertOne({ _id: "a" }), owned.insertOne({ _id: "b" })]);
    });
    expect((await col.find({})).docs.map(d => d._id).sort()).toEqual(["a", "b", "cascade"]);
  });

  test("removes an unused collection created through the transaction on rollback", async () => {
    const { db } = await setup();
    await expect(db.transaction(async tx => {
      tx.useCollection("unused");
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect(Object.keys(db.collections)).not.toContain("unused");
  });
});

describe("transaction handle lifetime", () => {
  test("rejects a suspended continuation after timeout and later transactions", async () => {
    const { db } = await setup();
    const entered = barrier(), release = barrier();
    let pending;
    db.use({ beforeInsert: async ({ doc }) => {
      if (doc._id === "late") { entered.resolve(); await release.promise; }
    } });
    const running = db.transaction(async tx => {
      pending = tx.useCollection("items").insertOne({ _id: "late" });
      await pending;
    }, { timeout: 20 });
    await entered.promise;
    await expect(running).rejects.toMatchObject({ code: "ERR_SKALEX_TX_TIMEOUT" });
    await db.transaction(async tx => { await tx.useCollection("items").insertOne({ _id: "fresh" }); });
    release.resolve();
    await expect(pending).rejects.toMatchObject({ code: "ERR_SKALEX_TX_ABORTED" });
    expect((await db.useCollection("items").find({})).docs.map(d => d._id)).toEqual(["fresh"]);
  });

  test("closes callback ownership while commit is suspended", async () => {
    const { db, adapter } = await setup();
    const entered = barrier(), release = barrier();
    const writeAll = adapter.writeAll.bind(adapter);
    adapter.writeAll = async entries => {
      entered.resolve();
      await release.promise;
      await writeAll(entries);
    };
    let owned, insert;
    const running = db.transaction(async tx => {
      owned = tx.useCollection("items");
      insert = owned.insertOne;
      await insert({ _id: "commit" });
    });
    await entered.promise;
    let stale;
    try { await insert({ _id: "late" }); } catch (e) { stale = e; }
    let outside;
    try { await db.useCollection("items").insertOne({ _id: "outside" }); } catch (e) { outside = e; }
    release.resolve();
    await running;
    expect(stale).toMatchObject({ code: "ERR_SKALEX_TX_STALE_PROXY" });
    expect(outside).toMatchObject({ code: "ERR_SKALEX_TX_COLLECTION_LOCKED" });
    expect((await db.useCollection("items").find({})).docs.map(d => d._id)).toEqual(["commit"]);
  });

  test("owns explicit creation and rejects replacing a definition inside a transaction", async () => {
    const { db } = await setup();
    await db.useCollection("existing").insertOne({ _id: "keep" });
    const failure = new Error("rollback");
    await expect(db.transaction(async tx => {
      await tx.createCollection("created", { schema: { n: "number" } }).insertOne({ n: 1 });
      expect(() => tx.createCollection("existing")).toThrow(expect.objectContaining({ code: "ERR_SKALEX_TX_DIRECT_ACCESS" }));
      throw failure;
    })).rejects.toBe(failure);
    expect(Object.keys(db.collections)).not.toContain("created");
    expect((await db.useCollection("existing").findOne({ _id: "keep" }))._id).toBe("keep");
  });

  test("locks transaction-created collections before their first write", async () => {
    const { db } = await setup();
    await db.transaction(async tx => {
      tx.useCollection("created");
      await expect(db.useCollection("created").insertOne({ _id: "outside" }))
        .rejects.toMatchObject({ code: "ERR_SKALEX_TX_COLLECTION_LOCKED" });
    });
    await db.useCollection("created").insertOne({ _id: "fresh" });
  });
});
