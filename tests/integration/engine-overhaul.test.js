/**
 * Regression tests for the engine overhaul:
 *   - Transaction timeout + abort safety
 *   - Dirty-save selectivity
 *   - Flush sentinel detection
 *   - Compound index candidate selection
 *   - Logical operators with edge cases
 */
import { describe, test, expect } from "vitest";
import Skalex from "../../src/index.js";
import MemoryAdapter from "../helpers/MemoryAdapter.js";

function makeDb(opts = {}) {
  const adapter = new MemoryAdapter();
  const db = new Skalex({ adapter, ...opts });
  return { db, adapter };
}

// ─── Transaction timeout + abort ────────────────────────────────────────────

describe("transaction timeout", () => {
  test("timed-out transaction rejects with ERR_SKALEX_TX_TIMEOUT", async () => {
    const { db } = makeDb();
    await db.connect();

    await expect(
      db.transaction(async (tx) => {
        await new Promise(r => setTimeout(r, 200));
      }, { timeout: 30 })
    ).rejects.toThrow(/timed out/i);

    await db.disconnect();
  });

  test("normal writes succeed after a timed-out transaction", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    await col.insertOne({ x: 1 });

    try {
      await db.transaction(async (tx) => {
        await tx.useCollection("items").insertOne({ x: 2 });
        await new Promise(r => setTimeout(r, 200));
      }, { timeout: 30 });
    } catch { }

    // Non-transactional write must not throw
    await col.insertOne({ x: 3 });
    const { docs } = await col.find({});
    // x:2 was rolled back, x:1 and x:3 remain
    expect(docs).toHaveLength(2);
    expect(docs.map(d => d.x).sort()).toEqual([1, 3]);
    await db.disconnect();
  });

  test("timed-out transaction rolls back mutations", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    await col.insertOne({ name: "original" });

    try {
      await db.transaction(async (tx) => {
        await tx.useCollection("items").insertOne({ name: "should-vanish" });
        await new Promise(r => setTimeout(r, 200));
      }, { timeout: 30 });
    } catch { }

    const { docs } = await col.find({});
    expect(docs).toHaveLength(1);
    expect(docs[0].name).toBe("original");
    await db.disconnect();
  });

  test("multiple sequential timed-out transactions do not corrupt state", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("items");

    for (let i = 0; i < 3; i++) {
      try {
        await db.transaction(async (tx) => {
          await tx.useCollection("items").insertOne({ round: i });
          await new Promise(r => setTimeout(r, 200));
        }, { timeout: 30 });
      } catch { }
    }

    // All 3 timed-out transactions should have rolled back
    expect(await col.count()).toBe(0);

    // Normal write still works
    await col.insertOne({ round: "final" });
    expect(await col.count()).toBe(1);
    await db.disconnect();
  });

  test("rolled-back transaction does not emit events", async () => {
    const { db } = makeDb();
    await db.connect();
    const events = [];
    db.watch(e => events.push(e));

    try {
      await db.transaction(async (tx) => {
        await tx.useCollection("items").insertOne({ x: 1 });
        throw new Error("abort");
      });
    } catch { }

    expect(events).toHaveLength(0);
    await db.disconnect();
  });

  test("rolled-back transaction does not increment session stats", async () => {
    const { db } = makeDb();
    await db.connect();

    try {
      await db.transaction(async (tx) => {
        await tx.useCollection("items").insertOne({ x: 1 }, { session: "s1" });
        throw new Error("abort");
      });
    } catch { }

    const stats = db.sessionStats("s1");
    expect(stats === null || stats.writes === 0).toBe(true);
    await db.disconnect();
  });
});

// ─── Dirty-save selectivity ─────────────────────────────────────────────────

describe("dirty tracking", () => {
  test("markDirty is set after mutation", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("items");

    expect(db.collections["items"]._dirty).toBe(false);
    await col.insertOne({ x: 1 });
    // After save, dirty is cleared - but if autoSave is off and save not called,
    // dirty should be true between mutation and save.
    // With autoSave off and no { save: true }, dirty stays true after pipeline.
    expect(db.collections["items"]._dirty).toBe(true);
    await db.disconnect();
  });

  test("save clears dirty flag", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    await col.insertOne({ x: 1 });
    expect(db.collections["items"]._dirty).toBe(true);

    await db.saveData("items");
    expect(db.collections["items"]._dirty).toBe(false);
    await db.disconnect();
  });

  test("saveDirty only flushes dirty collections", async () => {
    const { db, adapter } = makeDb();
    await db.connect();

    const a = db.useCollection("a");
    const b = db.useCollection("b");
    await a.insertOne({ x: 1 }, { save: true });
    await b.insertOne({ y: 1 }, { save: true });

    // Both saved and clean
    expect(db.collections["a"]._dirty).toBe(false);
    expect(db.collections["b"]._dirty).toBe(false);

    // Mutate only 'a'
    await a.insertOne({ x: 2 });
    expect(db.collections["a"]._dirty).toBe(true);
    expect(db.collections["b"]._dirty).toBe(false);

    // Record adapter writes
    const writeLog = [];
    const origWrite = adapter.write.bind(adapter);
    adapter.write = async (name, data) => {
      writeLog.push(name);
      return origWrite(name, data);
    };

    await db._persistence.saveDirty(db.collections);

    // Only 'a' should have been written
    expect(writeLog).toContain("a");
    expect(writeLog).not.toContain("b");
    expect(db.collections["a"]._dirty).toBe(false);
    await db.disconnect();
  });
});

// ─── Flush sentinel ─────────────────────────────────────────────────────────

describe("flush sentinel", () => {
  test("incomplete flush is detected on reload", async () => {
    const { db, adapter } = makeDb();
    await db.connect();

    // Manually inject an incomplete sentinel into _meta
    const metaCol = db.collections["_meta"] || (() => {
      db._createCollectionStore("_meta");
      return db.collections["_meta"];
    })();
    let metaDoc = metaCol.index.get("migrations");
    if (!metaDoc) {
      metaDoc = { _id: "migrations" };
      metaCol.data.push(metaDoc);
      metaCol.index.set("migrations", metaDoc);
    }
    metaDoc._flush = { startedAt: new Date().toISOString(), collections: ["users"], completedAt: null };
    await db.saveData("_meta");
    await db.disconnect();

    // Reload and check warning is logged
    const warnings = [];
    const db2 = new Skalex({ adapter, logger: (msg, level) => { if (level === "error") warnings.push(msg); } });
    await db2.connect();

    expect(warnings.some(w => w.includes("Incomplete flush"))).toBe(true);
    await db2.disconnect();
  });
});

// ─── Compound index candidate selection ─────────────────────────────────────

describe("compound index candidate selection", () => {
  test("find uses compound index for multi-field equality", async () => {
    const { db } = makeDb();
    const col = db.createCollection("items", {
      indexes: [["tenantId", "status"]],
    });
    await db.connect();

    await col.insertMany([
      { tenantId: "t1", status: "active", name: "A" },
      { tenantId: "t1", status: "inactive", name: "B" },
      { tenantId: "t2", status: "active", name: "C" },
      { tenantId: "t2", status: "active", name: "D" },
    ], { save: true });

    const { docs } = await col.find({ tenantId: "t2", status: "active" });
    expect(docs).toHaveLength(2);
    expect(docs.map(d => d.name).sort()).toEqual(["C", "D"]);
    await db.disconnect();
  });

  test("compound index does not interfere with single-field queries", async () => {
    const { db } = makeDb();
    const col = db.createCollection("items", {
      indexes: ["status", ["tenantId", "status"]],
    });
    await db.connect();

    await col.insertMany([
      { tenantId: "t1", status: "active", name: "A" },
      { tenantId: "t2", status: "active", name: "B" },
      { tenantId: "t2", status: "inactive", name: "C" },
    ], { save: true });

    // Single-field query should still work via single-field index
    const { docs } = await col.find({ status: "active" });
    expect(docs).toHaveLength(2);
    await db.disconnect();
  });
});

// ─── Logical operators edge cases ───────────────────────────────────────────

describe("logical operators edge cases", () => {
  test("$or with indexed predicates", async () => {
    const { db } = makeDb();
    const col = db.createCollection("items", { indexes: ["status"] });
    await db.connect();

    await col.insertMany([
      { status: "active", name: "A" },
      { status: "inactive", name: "B" },
      { status: "pending", name: "C" },
    ], { save: true });

    const { docs } = await col.find({ $or: [{ status: "active" }, { status: "pending" }] });
    expect(docs).toHaveLength(2);
    expect(docs.map(d => d.name).sort()).toEqual(["A", "C"]);
    await db.disconnect();
  });

  test("$not with soft-delete", async () => {
    const { db } = makeDb();
    const col = db.createCollection("items", { softDelete: true });
    await db.connect();

    await col.insertMany([
      { role: "admin", name: "A" },
      { role: "user", name: "B" },
      { role: "admin", name: "C" },
    ], { save: true });

    await col.deleteOne({ name: "A" });

    // $not should only see non-deleted docs
    const { docs } = await col.find({ $not: { role: "user" } });
    expect(docs).toHaveLength(1);
    expect(docs[0].name).toBe("C");
    await db.disconnect();
  });

  test("$and with $or nested", async () => {
    const { db } = makeDb();
    const col = db.useCollection("items");
    await db.connect();

    await col.insertMany([
      { a: 1, b: 2, c: 3 },
      { a: 1, b: 3, c: 3 },
      { a: 2, b: 2, c: 3 },
      { a: 2, b: 3, c: 4 },
    ], { save: true });

    const { docs } = await col.find({
      $and: [
        { $or: [{ a: 1 }, { a: 2 }] },
        { $or: [{ b: 2 }, { c: 4 }] },
      ]
    });
    // a=1,b=2 | a=2,b=2 | a=2,c=4
    expect(docs).toHaveLength(3);
    await db.disconnect();
  });

  test("$or combined with field-level filter and includeDeleted", async () => {
    const { db } = makeDb();
    const col = db.createCollection("items", { softDelete: true });
    await db.connect();

    await col.insertMany([
      { tag: "x", name: "A" },
      { tag: "y", name: "B" },
      { tag: "x", name: "C" },
    ], { save: true });

    await col.deleteOne({ name: "A" });

    // Without includeDeleted: only non-deleted
    const { docs: visible } = await col.find({ $or: [{ tag: "x" }, { tag: "y" }] });
    expect(visible).toHaveLength(2);

    // With includeDeleted: all 3
    const { docs: all } = await col.find({ $or: [{ tag: "x" }, { tag: "y" }] }, { includeDeleted: true });
    expect(all).toHaveLength(3);
    await db.disconnect();
  });

  test("findOne with $or", async () => {
    const { db } = makeDb();
    const col = db.useCollection("items");
    await db.connect();

    await col.insertMany([
      { name: "A", score: 10 },
      { name: "B", score: 20 },
    ], { save: true });

    const doc = await col.findOne({ $or: [{ name: "B" }, { name: "C" }] });
    expect(doc).not.toBeNull();
    expect(doc.name).toBe("B");
    await db.disconnect();
  });

  test("updateMany with $or filter", async () => {
    const { db } = makeDb();
    const col = db.useCollection("items");
    await db.connect();

    await col.insertMany([
      { name: "A", score: 10 },
      { name: "B", score: 20 },
      { name: "C", score: 30 },
    ], { save: true });

    await col.updateMany({ $or: [{ name: "A" }, { name: "C" }] }, { score: 99 });
    const { docs } = await col.find({ score: 99 });
    expect(docs).toHaveLength(2);
    await db.disconnect();
  });

  test("deleteMany with $not filter", async () => {
    const { db } = makeDb();
    const col = db.useCollection("items");
    await db.connect();

    await col.insertMany([
      { name: "A", keep: true },
      { name: "B", keep: false },
      { name: "C", keep: false },
    ], { save: true });

    await col.deleteMany({ $not: { keep: true } });
    const { docs } = await col.find({});
    expect(docs).toHaveLength(1);
    expect(docs[0].name).toBe("A");
    await db.disconnect();
  });
});

// ─── Typed errors ───────────────────────────────────────────────────────────

describe("typed errors", () => {
  test("validation error has code and details", async () => {
    const { db } = makeDb();
    const col = db.createCollection("items", {
      schema: { name: { type: "string", required: true } },
    });
    await db.connect();

    try {
      await col.insertOne({ score: 42 });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e.name).toBe("ValidationError");
      expect(e.code).toBe("ERR_SKALEX_VALIDATION_FAILED");
      expect(e.details.errors).toBeDefined();
    }
    await db.disconnect();
  });

  test("unique constraint error has code and details", async () => {
    const { db } = makeDb();
    const col = db.createCollection("items", {
      schema: { email: { type: "string", unique: true } },
    });
    await db.connect();

    await col.insertOne({ email: "a@test.com" });
    try {
      await col.insertOne({ email: "a@test.com" });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e.name).toBe("UniqueConstraintError");
      expect(e.code).toBe("ERR_SKALEX_UNIQUE_VIOLATION");
      expect(e.details.field).toBe("email");
    }
    await db.disconnect();
  });

  test("transaction error on direct collections access", async () => {
    const { db } = makeDb();
    await db.connect();

    await expect(
      db.transaction(async (tx) => {
        void tx.collections;
      })
    ).rejects.toMatchObject({ name: "TransactionError", code: "ERR_SKALEX_TX_DIRECT_ACCESS" });
    await db.disconnect();
  });
});

// ─── Fault injection ────────────────────────────────────────────────────────

describe("fault injection: adapter write failures", () => {
  test("saveData rejects when adapter.write fails", async () => {
    const { db, adapter } = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    await col.insertOne({ x: 1 });

    const origWrite = adapter.write.bind(adapter);
    adapter.write = async () => { throw new Error("disk full"); };

    await expect(db.saveData("items")).rejects.toThrow("disk full");

    // Restore adapter so disconnect can clean up
    adapter.write = origWrite;
    await db.disconnect();
  });

  test("transaction commit fails if writeAll fails, and state is rolled back", async () => {
    const { db, adapter } = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    await col.insertOne({ x: 1 }, { save: true });

    const origWrite = adapter.write.bind(adapter);
    const origWriteAll = adapter.writeAll.bind(adapter);
    adapter.writeAll = async () => { throw new Error("disk full"); };
    adapter.write = async (name, data) => {
      // Allow _meta writes for sentinel, fail on data
      if (name === "_meta") return origWrite(name, data);
      throw new Error("disk full");
    };

    await expect(
      db.transaction(async (tx) => {
        await tx.useCollection("items").insertOne({ x: 2 });
      })
    ).rejects.toThrow(/disk full|flush/i);

    // State should be rolled back - only x:1 remains
    const { docs } = await col.find({});
    expect(docs).toHaveLength(1);
    expect(docs[0].x).toBe(1);

    // Restore adapter for cleanup
    adapter.write = origWrite;
    adapter.writeAll = origWriteAll;
    await db.disconnect();
  });

  test("partial batch failure in writeAll does not leave inconsistent state", async () => {
    const { db, adapter } = makeDb();
    await db.connect();

    const a = db.useCollection("a");
    const b = db.useCollection("b");
    await a.insertOne({ v: 1 }, { save: true });
    await b.insertOne({ v: 1 }, { save: true });

    let writeCount = 0;
    const origWrite = adapter.write.bind(adapter);
    adapter.writeAll = async (entries) => {
      for (const { name, data } of entries) {
        writeCount++;
        if (writeCount > 1) throw new Error("partial failure");
        await origWrite(name, data);
      }
    };

    await expect(
      db.transaction(async (tx) => {
        await tx.useCollection("a").insertOne({ v: 2 });
        await tx.useCollection("b").insertOne({ v: 2 });
      })
    ).rejects.toThrow(/partial failure|flush/i);

    // Both collections should be rolled back to v:1 only
    expect((await a.find({})).docs).toHaveLength(1);
    expect((await b.find({})).docs).toHaveLength(1);
    await db.disconnect();
  });

  test("adapter.read failure during connect throws PersistenceError by default", async () => {
    const adapter = new MemoryAdapter();
    await adapter.write("broken", "not-json");

    const db = new Skalex({ adapter });
    await expect(db.connect()).rejects.toThrow(/Failed to load collection "broken"/);
  });

  test("adapter.read failure during connect logs warning with lenientLoad", async () => {
    const adapter = new MemoryAdapter();
    await adapter.write("users", JSON.stringify({ collectionName: "users", data: [{ _id: "1", name: "A" }] }));
    await adapter.write("broken", "not-json");

    const warnings = [];
    const db = new Skalex({ adapter, lenientLoad: true, logger: (msg, level) => { if (level === "error") warnings.push(msg); } });
    await db.connect();

    // The valid collection loaded fine
    const col = db.useCollection("users");
    const doc = await col.findOne({ name: "A" });
    expect(doc).not.toBeNull();

    // The broken collection was logged as a warning
    expect(warnings.some(w => w.includes("broken"))).toBe(true);
    await db.disconnect();
  });
});

describe("fault injection: stale continuation detection", () => {
  test("mutation started during active tx is rejected if tx aborts mid-flight", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("items");

    // A mutation that starts during a tx but whose async work (e.g. embed)
    // takes long enough for the tx to time out before the mutation boundary.
    // The assertTxAlive guard inside mutate() should catch this.
    try {
      await db.transaction(async (tx) => {
        const c = tx.useCollection("items");
        // Start two concurrent operations - one will timeout
        await Promise.all([
          c.insertOne({ fast: true }),
          new Promise(r => setTimeout(r, 200)), // force timeout
        ]);
      }, { timeout: 30 });
    } catch { }

    // The insert that completed before timeout was rolled back
    expect(await col.count()).toBe(0);
    await db.disconnect();
  });

  test("multiple sequential aborted transactions all roll back cleanly", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("items");

    for (let i = 0; i < 5; i++) {
      try {
        await db.transaction(async (tx) => {
          await tx.useCollection("items").insertOne({ round: i });
          throw new Error("abort");
        });
      } catch { }
    }

    // All 5 aborted - no data
    expect(await col.count()).toBe(0);

    // Normal write still works
    await col.insertOne({ final: true });
    expect(await col.count()).toBe(1);
    await db.disconnect();
  });
});

describe("collection instance poisoning after aborted transaction", () => {
  test("collection first created inside aborted tx is usable afterward", async () => {
    const { db } = makeDb();
    await db.connect();

    // First useCollection("items") happens inside a transaction that aborts
    try {
      await db.transaction(async (tx) => {
        await tx.useCollection("items").insertOne({ x: 1 });
        throw new Error("abort");
      });
    } catch {}

    // The cached Collection instance must not be permanently poisoned
    const col = db.useCollection("items");
    await col.insertOne({ x: 2 });
    expect(await col.count()).toBe(1);
    expect((await col.findOne({})).x).toBe(2);
    await db.disconnect();
  });
});

// ─── applyUpdate correctness ────────────────────────────────────────────────

describe("applyUpdate operator correctness", () => {
  test("$inc increments a numeric field", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    await col.insertOne({ name: "A", score: 10 });
    const updated = await col.updateOne({ name: "A" }, { score: { $inc: 5 } });
    expect(updated.score).toBe(15);
    await db.disconnect();
  });

  test("$push appends to an array field", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    await col.insertOne({ name: "A", tags: ["x"] });
    const updated = await col.updateOne({ name: "A" }, { tags: { $push: "y" } });
    expect(updated.tags).toEqual(["x", "y"]);
    await db.disconnect();
  });

  test("$push auto-initialises missing field as array", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    await col.insertOne({ name: "A" });
    const updated = await col.updateOne({ name: "A" }, { tags: { $push: "first" } });
    expect(updated.tags).toEqual(["first"]);
    await db.disconnect();
  });

  test("mixed $inc and plain key does not corrupt field", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    await col.insertOne({ name: "A", score: 10 });
    // { score: { $inc: 5, label: "high" } } - $inc should apply, label should be ignored
    const updated = await col.updateOne({ name: "A" }, { score: { $inc: 5, label: "high" } });
    expect(updated.score).toBe(15);
    await db.disconnect();
  });

  test("$inc on missing field is a no-op (field stays undefined)", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    await col.insertOne({ name: "A" });
    const updated = await col.updateOne({ name: "A" }, { score: { $inc: 5 } });
    // $inc requires an existing numeric field - missing field is not initialized
    expect(updated.score).toBeUndefined();
    await db.disconnect();
  });

  test("$inc on non-numeric field is a no-op", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    await col.insertOne({ name: "A", score: "not-a-number" });
    const updated = await col.updateOne({ name: "A" }, { score: { $inc: 5 } });
    expect(updated.score).toBe("not-a-number");
    await db.disconnect();
  });

  test("plain nested object is assigned directly", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    await col.insertOne({ name: "A", meta: {} });
    const updated = await col.updateOne({ name: "A" }, { meta: { foo: "bar", baz: 42 } });
    expect(updated.meta).toEqual({ foo: "bar", baz: 42 });
    await db.disconnect();
  });
});

// ─── Transaction rollback for update/delete ─────────────────────────────────

describe("transaction rollback for update and delete", () => {
  test("updateOne is rolled back on transaction failure", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    await col.insertOne({ name: "A", score: 10 }, { save: true });

    try {
      await db.transaction(async (tx) => {
        await tx.useCollection("items").updateOne({ name: "A" }, { score: 99 });
        throw new Error("abort");
      });
    } catch {}

    const doc = await col.findOne({ name: "A" });
    expect(doc.score).toBe(10);
    await db.disconnect();
  });

  test("deleteOne is rolled back on transaction failure", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    await col.insertOne({ name: "A" }, { save: true });

    try {
      await db.transaction(async (tx) => {
        await tx.useCollection("items").deleteOne({ name: "A" });
        throw new Error("abort");
      });
    } catch {}

    expect(await col.count()).toBe(1);
    await db.disconnect();
  });

  test("updateMany is rolled back on transaction failure", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    await col.insertMany([{ name: "A", v: 1 }, { name: "B", v: 2 }], { save: true });

    try {
      await db.transaction(async (tx) => {
        await tx.useCollection("items").updateMany({}, { v: 99 });
        throw new Error("abort");
      });
    } catch {}

    const { docs } = await col.find({});
    expect(docs.map(d => d.v).sort()).toEqual([1, 2]);
    await db.disconnect();
  });

  test("deleteMany is rolled back on transaction failure", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    await col.insertMany([{ name: "A" }, { name: "B" }], { save: true });

    try {
      await db.transaction(async (tx) => {
        await tx.useCollection("items").deleteMany({});
        throw new Error("abort");
      });
    } catch {}

    expect(await col.count()).toBe(2);
    await db.disconnect();
  });
});

// ─── Capped collection (maxDocs) ────────────────────────────────────────────

describe("maxDocs capped collection", () => {
  test("insertOne evicts oldest when at capacity", async () => {
    const { db } = makeDb();
    const col = db.createCollection("items", { maxDocs: 3 });
    await db.connect();

    await col.insertMany([{ v: 1 }, { v: 2 }, { v: 3 }]);
    await col.insertOne({ v: 4 });

    const { docs } = await col.find({});
    expect(docs).toHaveLength(3);
    expect(docs.map(d => d.v)).toEqual([2, 3, 4]);
    await db.disconnect();
  });

  test("insertMany that exceeds capacity evicts correctly", async () => {
    const { db } = makeDb();
    const col = db.createCollection("items", { maxDocs: 3 });
    await db.connect();

    await col.insertMany([{ v: 1 }, { v: 2 }, { v: 3 }, { v: 4 }, { v: 5 }]);

    const { docs } = await col.find({});
    expect(docs).toHaveLength(3);
    expect(docs.map(d => d.v)).toEqual([3, 4, 5]);
    await db.disconnect();
  });
});
