import { afterEach, describe, expect, test } from "vitest";
import Skalex from "../../src/index.js";
import MemoryAdapter from "../helpers/MemoryAdapter.js";
import expectIndexMatchesScan from "../helpers/expectIndexMatchesScan.js";

const databases = [];
afterEach(async () => {
  for (const db of databases.splice(0)) await db.disconnect();
});
async function setup(config = {}, options = {}) {
  const adapter = new MemoryAdapter();
  const db = new Skalex({ adapter, ...config });
  databases.push(db);
  await db.connect();
  const col = db.createCollection("items", {
    schema: { n: { type: "number", unique: true } },
    indexes: [["n", "group"]], changelog: true, ...options,
  });
  return { db, col, adapter };
}
const rows = docs => docs.map(d => [d.sku, d.n]);
async function reopen(adapter) {
  const db = new Skalex({ adapter });
  databases.push(db);
  await db.connect();
  return db.useCollection("items");
}

describe("failed upsertMany prefix bookkeeping", () => {
  test.each([
    [true, undefined, true],
    [false, true, true],
    [true, false, false],
    [false, undefined, false],
  ])("honors autoSave=%s and save=%s for completed items", async (autoSave, save, persisted) => {
    const { db, col, adapter } = await setup({ autoSave });
    await col.insertOne({ _id: "a", sku: "A", n: 1, group: "g" }, { save: true });
    const events = [], hooks = [];
    db.watch(event => { if (event.collection === "items") events.push([event.op, event.doc.sku]); });
    db.use({
      afterInsert: ({ collection, doc }) => { if (collection === "items") hooks.push(["insert", doc.sku]); },
      afterUpdate: ({ collection, result }) => { if (collection === "items") hooks.push(["update", result.sku]); },
    });
    let writes = 0;
    const original = adapter.write.bind(adapter);
    adapter.write = async (name, data) => { if (name === "items") writes++; await original(name, data); };
    await expect(col.upsertMany([
      { sku: "A", n: 2, group: "g" },
      { _id: "b", sku: "B", n: 3, group: "g" },
      { _id: "c", sku: "C", n: 3, group: "g" },
      { _id: "d", sku: "D", n: 4, group: "g" },
    ], "sku", { save, session: "batch" })).rejects.toMatchObject({ code: "ERR_SKALEX_UNIQUE_VIOLATION" });
    expect(rows((await col.find({})).docs)).toEqual([["A", 2], ["B", 3]]);
    for (const n of [1, 2, 3, 4]) {
      await expectIndexMatchesScan(col, "n", n);
      await expectIndexMatchesScan(col, { n, group: "g" });
    }
    expect(events).toEqual([["update", "A"], ["insert", "B"]]);
    expect(hooks).toEqual(events);
    const entries = await db.changelog().query("items", { session: "batch" });
    expect(entries.map(e => [e.op, e.doc.sku])).toEqual(events);
    expect(entries[0].prev.n).toBe(1);
    expect(db.sessionStats("batch").writes).toBe(1);
    expect(writes).toBe(persisted ? 1 : 0);
    const loaded = await reopen(adapter);
    expect(rows((await loaded.find({})).docs)).toEqual(persisted ? [["A", 2], ["B", 3]] : [["A", 1]]);
    if (!persisted) {
      await db.saveData("items");
      expect(writes).toBe(1);
      expect(rows((await (await reopen(adapter)).find({})).docs)).toEqual([["A", 2], ["B", 3]]);
    }
  });

  test.each([
    ["schema", { sku: "bad", n: "wrong" }, "ERR_SKALEX_VALIDATION_FAILED"],
    ["id", { _id: "a", sku: "bad", n: 2 }, "ERR_SKALEX_UNIQUE_DUPLICATE_ID"],
    ["compound", { sku: "bad", n: 2, group: {} }, "ERR_SKALEX_VALIDATION_COMPOUND_INDEX"],
  ])("finalizes the prefix after a %s rejection", async (_kind, invalid, code) => {
    const { db, col, adapter } = await setup({ autoSave: true });
    await expect(col.upsertMany([{ _id: "a", sku: "A", n: 1, group: "g" }, invalid], "sku")).rejects.toMatchObject({ code });
    expect(rows((await (await reopen(adapter)).find({})).docs)).toEqual([["A", 1]]);
    expect((await db.changelog().query("items")).map(e => e.doc.sku)).toEqual(["A"]);
    await expectIndexMatchesScan(col, "n", 1);
  });

  test("preserves even an undefined hook rejection after finalizing the prefix", async () => {
    const { db, col, adapter } = await setup({ autoSave: true });
    db.use({ beforeInsert: ({ collection, doc }) => { if (collection === "items" && doc.sku === "bad") throw undefined; } });
    const outcome = await col.upsertMany([{ sku: "A", n: 1 }, { sku: "bad", n: 2 }], "sku")
      .then(() => ({ resolved: true }), error => ({ rejected: true, error }));
    expect(outcome).toEqual({ rejected: true, error: undefined });
    expect(rows((await (await reopen(adapter)).find({})).docs)).toEqual([["A", 1]]);
  });

  test("a first-item rejection has no prefix effects", async () => {
    const { db, col, adapter } = await setup({ autoSave: true });
    const events = [];
    db.watch(event => events.push(event));
    await expect(col.upsertMany([{ n: "wrong" }], "sku", { session: "empty" })).rejects.toBeDefined();
    expect(events).toEqual([]);
    expect((await db.changelog().query("items"))).toEqual([]);
    expect(db.sessionStats("empty")?.writes ?? 0).toBe(0);
    expect(await adapter.read("items")).toBeNull();
  });

  test("applies the collection cap to successful inserts before rethrowing", async () => {
    const { col, adapter } = await setup({ autoSave: true }, { maxDocs: 1 });
    await col.insertOne({ sku: "old", n: 1 });
    await expect(col.upsertMany([{ sku: "A", n: 2 }, { sku: "bad", n: 2 }], "sku"))
      .rejects.toMatchObject({ code: "ERR_SKALEX_UNIQUE_VIOLATION" });
    expect(rows((await col.find({})).docs)).toEqual([["A", 2]]);
    expect(rows((await (await reopen(adapter)).find({})).docs)).toEqual([["A", 2]]);
  });

  test("does not discard a separate write while a batch hook is awaiting", async () => {
    const { db, col, adapter } = await setup({ autoSave: true });
    let entered, release;
    const ready = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    db.use({ beforeInsert: async ({ collection, doc }) => {
      if (collection === "items" && doc.sku === "blocked") { entered(); await gate; }
    } });
    const pending = col.upsertMany([{ sku: "A", n: 1 }, { sku: "blocked", n: 1 }], "sku");
    const result = pending.then(() => null, error => error);
    await ready;
    try { await col.insertOne({ sku: "other", n: 2 }); } finally { release(); }
    expect((await result).code).toBe("ERR_SKALEX_UNIQUE_VIOLATION");
    expect(rows((await (await reopen(adapter)).find({})).docs)).toEqual([["A", 1], ["other", 2]]);
    expect((await db.changelog().query("items")).map(e => e.doc.sku).sort()).toEqual(["A", "other"]);
  });

  test.each([false, true])("transaction catch=%s preserves transaction effect semantics", async caught => {
    const { db, col, adapter } = await setup({ autoSave: true });
    await col.insertOne({ sku: "old", n: 1 });
    const events = [], hooks = [];
    db.watch(event => { if (event.collection === "items") events.push(event.doc.sku); });
    db.use({ afterInsert: ({ collection, doc }) => { if (collection === "items") hooks.push(doc.sku); } });
    const transaction = db.transaction(async tx => {
      try {
        await tx.useCollection("items").upsertMany([{ sku: "A", n: 2 }, { sku: "bad", n: 2 }], "sku", { session: "tx" });
      } catch (error) {
        expect(events).toEqual([]);
        expect(hooks).toEqual([]);
        if (!caught) throw error;
      }
    });
    if (caught) await transaction;
    else await expect(transaction).rejects.toMatchObject({ code: "ERR_SKALEX_UNIQUE_VIOLATION" });
    expect(events).toEqual(caught ? ["A"] : []);
    expect(hooks).toEqual(events);
    expect(db.sessionStats("tx")?.writes ?? 0).toBe(caught ? 1 : 0);
    expect((await db.changelog().query("items", { session: "tx" })).map(e => e.doc.sku)).toEqual(events);
    expect(rows((await (await reopen(adapter)).find({})).docs)).toEqual(caught ? [["old", 1], ["A", 2]] : [["old", 1]]);
  });
  test.each(["save", "afterHook"])("reports both failures when %s fails during prefix finalization", async stage => {
    const { db, col, adapter } = await setup({ autoSave: true });
    const secondError = new TypeError("completion failed");
    if (stage === "save") {
      const write = adapter.write.bind(adapter);
      adapter.write = async (name, data) => { if (name === "items") throw secondError; await write(name, data); };
    } else {
      db.use({ afterInsert: ({ collection }) => { if (collection === "items") throw secondError; } });
    }
    try {
      const error = await col.upsertMany([{ sku: "A", n: 1 }, { sku: "bad", n: 1 }], "sku")
        .then(() => null, reason => reason);
      expect(error).toMatchObject({
        code: "ERR_SKALEX_MUTATION_FINALIZE",
        details: { collection: "items", mutationError: { code: "ERR_SKALEX_UNIQUE_VIOLATION" } },
      });
      expect(error.details.finalizationError).toBe(secondError);
      expect(rows((await col.find({})).docs)).toEqual([["A", 1]]);
    } finally {
      if (stage === "save") delete adapter.write;
    }
    await db.saveData("items");
    expect(rows((await (await reopen(adapter)).find({})).docs)).toEqual([["A", 1]]);
  });

  test("does not finalize a prefix after its transaction has timed out and rolled back", async () => {
    const { db, col } = await setup({ autoSave: true });
    await col.insertOne({ sku: "old", n: 1 });
    let entered, release, pending;
    const ready = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    db.use({ beforeInsert: async ({ collection, doc }) => {
      if (collection === "items" && doc.sku === "blocked") { entered(); await gate; }
    } });
    const events = [];
    db.watch(event => { if (event.collection === "items") events.push(event); });
    const transaction = db.transaction(async tx => {
      pending = tx.useCollection("items").upsertMany([{ sku: "A", n: 2 }, { sku: "blocked", n: 3 }], "sku", { session: "timeout" });
      await pending;
    }, { timeout: 20 });
    const completed = transaction.then(() => null, error => error);
    await ready;
    try { expect((await completed).code).toBe("ERR_SKALEX_TX_TIMEOUT"); }
    finally { release(); }
    await expect(pending).rejects.toMatchObject({ code: "ERR_SKALEX_TX_ABORTED" });
    expect(events).toEqual([]);
    expect(db.sessionStats("timeout")?.writes ?? 0).toBe(0);
    expect((await db.changelog().query("items", { session: "timeout" }))).toEqual([]);
    expect(rows((await col.find({})).docs)).toEqual([["old", 1]]);
  });

  test("a rejected update preserves its old document and finalizes only earlier items", async () => {
    const { db, col, adapter } = await setup({ autoSave: true });
    await col.insertOne({ sku: "old", n: 1, group: "g" });
    const effects = [];
    db.use({
      afterInsert: ({ collection, doc }) => { if (collection === "items") effects.push(["insert", doc.sku]); },
      afterUpdate: ({ collection, result }) => { if (collection === "items") effects.push(["update", result.sku]); },
    });
    await expect(col.upsertMany([{ sku: "A", n: 2, group: "g" }, { sku: "old", n: 2 }], "sku", { session: "update-failure" }))
      .rejects.toMatchObject({ code: "ERR_SKALEX_UNIQUE_VIOLATION" });
    expect(rows((await (await reopen(adapter)).find({})).docs)).toEqual([["old", 1], ["A", 2]]);
    expect(effects).toEqual([["insert", "A"]]);
    expect((await db.changelog().query("items", { session: "update-failure" })).map(e => e.op)).toEqual(["insert"]);
    await expectIndexMatchesScan(col, "n", 1);
    await expectIndexMatchesScan(col, "n", 2);
  });

});
