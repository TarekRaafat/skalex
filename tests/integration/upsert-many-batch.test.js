/**
 * Regression tests for the alpha.6 upsertMany batch pipeline.
 *
 * Guarantees verified:
 *   1. Per-doc plugin hooks (beforeInsert/afterInsert, beforeUpdate/afterUpdate)
 *      fire once per matching document, with the correct payload shape.
 *   2. Per-doc events emit with the correct `op` (insert vs update) for a
 *      mixed batch.
 *   3. Per-doc changelog entries record the actual operation per document.
 *   4. Pipeline-level side effects fire exactly once per batch:
 *        - a single save (dirty write),
 *        - a single session-stats increment,
 *        - a single markDirty/persistence touch.
 *   5. A failing item inside a transaction rolls back the entire batch.
 *   6. Mixed insert + update in one call returns both operations.
 */
import { describe, test, expect } from "vitest";
import Skalex from "../../src/index.js";
import MemoryAdapter from "../helpers/MemoryAdapter.js";

describe("upsertMany batch pipeline", () => {
  test("fires per-doc plugin hooks with op-correct payloads on mixed batch", async () => {
    const adapter = new MemoryAdapter();
    const db = new Skalex({ adapter });
    const beforeInserts = [];
    const beforeUpdates = [];
    const afterInserts = [];
    const afterUpdates = [];
    db.use({
      name: "track",
      beforeInsert: async (ctx) => { beforeInserts.push(ctx.doc); },
      beforeUpdate: async (ctx) => { beforeUpdates.push({ filter: ctx.filter, update: ctx.update }); },
      afterInsert: async (ctx) => { afterInserts.push(ctx.doc); },
      afterUpdate: async (ctx) => { afterUpdates.push(ctx.result); },
    });
    await db.connect();
    const col = db.useCollection("items");
    await col.insertOne({ sku: "A", qty: 1 });
    beforeInserts.length = 0; afterInserts.length = 0;

    await col.upsertMany([
      { sku: "A", qty: 100 }, // update
      { sku: "B", qty: 5 },   // insert
      { sku: "C", qty: 7 },   // insert
    ], "sku");

    expect(beforeInserts).toHaveLength(2);
    expect(beforeUpdates).toHaveLength(1);
    expect(afterInserts).toHaveLength(2);
    expect(afterUpdates).toHaveLength(1);
    expect(beforeUpdates[0].filter).toEqual({ sku: "A" });
    await db.disconnect();
  });

  test("emits per-doc watch events with correct op for each document", async () => {
    const adapter = new MemoryAdapter();
    const db = new Skalex({ adapter });
    await db.connect();
    const col = db.useCollection("items");
    await col.insertOne({ k: "a", v: 1 });

    const events = [];
    const unsub = db.watch((ev) => {
      if (ev.collection === "items") events.push({ op: ev.op, k: ev.doc.k });
    });

    await col.upsertMany([
      { k: "a", v: 99 }, // update
      { k: "b", v: 2 },  // insert
    ], "k");

    unsub();
    // One update + one insert; order follows the batch order.
    expect(events).toEqual([
      { op: "update", k: "a" },
      { op: "insert", k: "b" },
    ]);
    await db.disconnect();
  });

  test("records one changelog entry per document with correct op", async () => {
    const adapter = new MemoryAdapter();
    const db = new Skalex({ adapter });
    await db.connect();
    db.createCollection("items", { changelog: true });
    const col = db.useCollection("items");
    await col.insertOne({ code: "X", n: 1 });

    await col.upsertMany([
      { code: "X", n: 99 }, // update
      { code: "Y", n: 2 },  // insert
      { code: "Z", n: 3 },  // insert
    ], "code");

    const entries = await db.changelog().query("items");
    // 1 initial insert + 1 update + 2 inserts = 4
    expect(entries).toHaveLength(4);
    const ops = entries.map(e => e.op);
    expect(ops.slice(-3)).toEqual(["update", "insert", "insert"]);
    await db.disconnect();
  });

  test("batch triggers a single save on the collection", async () => {
    const adapter = new MemoryAdapter();
    const db = new Skalex({ adapter, autoSave: true });
    await db.connect();
    const col = db.useCollection("items");

    // Wrap adapter.write to count invocations for the target collection.
    let writes = 0;
    const origWrite = adapter.write.bind(adapter);
    adapter.write = async (name, data) => {
      if (name === "items") writes++;
      return origWrite(name, data);
    };

    await col.upsertMany([
      { sku: "A", qty: 1 },
      { sku: "B", qty: 2 },
      { sku: "C", qty: 3 },
      { sku: "D", qty: 4 },
      { sku: "E", qty: 5 },
    ], "sku");

    // Pre-alpha.6 this ran 5 writes (one per doc) because each per-doc
    // upsert resolved its own autoSave flush. After the batch pipeline
    // it must be 1.
    expect(writes).toBe(1);
    await db.disconnect();
  });

  test("records a single session-stats write for the whole batch", async () => {
    const adapter = new MemoryAdapter();
    const db = new Skalex({ adapter });
    await db.connect();
    const col = db.useCollection("items");

    const statsBefore = db.sessionStats("s1") ?? { writes: 0 };
    await col.upsertMany([
      { sku: "A", qty: 1 },
      { sku: "B", qty: 2 },
      { sku: "C", qty: 3 },
    ], "sku", { session: "s1" });
    const statsAfter = db.sessionStats("s1") ?? { writes: 0 };

    expect(statsAfter.writes - statsBefore.writes).toBe(1);
    await db.disconnect();
  });

  test("transaction rollback reverts the entire batch atomically", async () => {
    const adapter = new MemoryAdapter();
    const db = new Skalex({ adapter });
    await db.connect();
    const items = db.useCollection("items");
    await items.insertOne({ sku: "A", qty: 1 });

    await expect(db.transaction(async (tx) => {
      const txItems = tx.useCollection("items");
      await txItems.upsertMany([
        { sku: "A", qty: 100 }, // update
        { sku: "B", qty: 2 },   // insert
      ], "sku");
      throw new Error("boom");
    })).rejects.toThrow(/boom/);

    const all = await items.find({}, { sort: { sku: 1 } });
    // Original A untouched, B never created.
    expect(all.docs).toHaveLength(1);
    expect(all.docs[0]).toMatchObject({ sku: "A", qty: 1 });
    await db.disconnect();
  });

  test("mixed insert + update batch returns committed docs in input order", async () => {
    const adapter = new MemoryAdapter();
    const db = new Skalex({ adapter });
    await db.connect();
    const col = db.useCollection("items");
    await col.insertMany([
      { code: "X", val: 1 },
      { code: "Y", val: 2 },
    ]);

    const result = await col.upsertMany([
      { code: "X", val: 100 }, // update
      { code: "Z", val: 3 },   // insert
      { code: "Y", val: 200 }, // update
    ], "code");

    expect(result).toHaveLength(3);
    expect(result[0].val).toBe(100);
    expect(result[1].val).toBe(3);
    expect(result[2].val).toBe(200);
    await db.disconnect();
  });

  test("empty docs array is a no-op", async () => {
    const adapter = new MemoryAdapter();
    const db = new Skalex({ adapter });
    let called = 0;
    db.use({ name: "n", beforeInsert: () => { called++; }, beforeUpdate: () => { called++; } });
    await db.connect();
    const col = db.useCollection("items");
    const result = await col.upsertMany([], "sku");
    expect(result).toEqual([]);
    expect(called).toBe(0);
    await db.disconnect();
  });
});
