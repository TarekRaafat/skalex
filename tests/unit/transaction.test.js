/**
 * Unit tests for TransactionManager - lifecycle, bounded aborted-id set,
 * per-instance counter isolation, timeout, nested detection, and the
 * deferred-effect error strategy (instance default + per-transaction override).
 */
import { describe, test, expect } from "vitest";
import Skalex from "../../src/index.js";
import MemoryAdapter from "../helpers/MemoryAdapter.js";
import TransactionManager from "../../src/engine/transaction.js";

function makeDb(opts = {}) {
  return new Skalex({ adapter: new MemoryAdapter(), ...opts });
}

// ─── aborted-id pruning ─────────────────────────────────────────────────────

describe("TransactionManager  -  _abortedIds pruning", () => {
  test("running many timed-out transactions does not grow _abortedIds past the window", async () => {
    // Use a short window so we can verify pruning with a handful of real tx runs.
    const db = new Skalex({ adapter: new MemoryAdapter() });
    db._txManager = new TransactionManager({ abortedIdWindow: 3 });
    await db.connect();

    const txm = db._txManager;

    // Fire 10 transactions that time out. Each one should add its id to
    // _abortedIds after the timeout, then prune IDs older than (counter - 3).
    for (let i = 0; i < 10; i++) {
      try {
        await db.transaction(async () => {
          // Block longer than the timeout so the race rejects.
          await new Promise((r) => setTimeout(r, 20));
        }, { timeout: 1 });
      } catch { /* expected TX_TIMEOUT */ }
    }

    // Counter must have advanced to at least 10.
    expect(txm._idCounter).toBeGreaterThanOrEqual(10);
    // And the aborted set must be bounded by the window (3), not 10.
    expect(txm._abortedIds.size).toBeLessThanOrEqual(3);
    // The most recent IDs should be the ones retained.
    const retained = [...txm._abortedIds].sort((a, b) => a - b);
    for (const id of retained) {
      expect(id).toBeGreaterThan(txm._idCounter - txm._abortedIdWindow - 1);
    }
  });

  test("per-instance counter is isolated between Skalex instances", async () => {
    const a = new Skalex({ adapter: new MemoryAdapter() });
    const b = new Skalex({ adapter: new MemoryAdapter() });
    await a.connect();
    await b.connect();
    await a.transaction(async () => {});
    await a.transaction(async () => {});
    await b.transaction(async () => {});
    expect(a._txManager._idCounter).toBe(2);
    expect(b._txManager._idCounter).toBe(1);
  });
});

// ─── timeout option ─────────────────────────────────────────────────────────

describe("TransactionManager  -  timeout option", () => {
  test("transaction honours { timeout } option", async () => {
    const db = makeDb();
    await db.connect();
    let err = null;
    try {
      await db.transaction(async (tx) => {
        await tx.useCollection("x").insertOne({ v: 1 });
        await new Promise((r) => setTimeout(r, 100));
        await tx.useCollection("x").insertOne({ v: 2 });
      }, { timeout: 10 });
    } catch (e) { err = e; }
    expect(err?.code).toBe("ERR_SKALEX_TX_TIMEOUT");
  });
});

// ─── nested transaction detection ──────────────────────────────────────────

describe("TransactionManager  -  nested transaction detection", () => {
  test("throws TransactionError when called inside another transaction", async () => {
    const db = makeDb();
    await db.connect();
    let inner = null;
    await db.transaction(async () => {
      try { await db.transaction(async () => {}); }
      catch (e) { inner = e; }
    });
    expect(inner).toBeTruthy();
    expect(inner.code).toBe("ERR_SKALEX_TX_NESTED");
  });
});

// ─── deferred-effect error strategy ────────────────────────────────────────

describe("TransactionManager  -  deferredEffectErrors strategy", () => {
  test("\"warn\" logs and completes the transaction", async () => {
    const logs = [];
    const db = new Skalex({
      adapter: new MemoryAdapter(),
      deferredEffectErrors: "warn",
      logger: (msg, level) => logs.push({ msg, level }),
    });
    db.use({
      async afterInsert() { throw new Error("boom"); },
    });
    await db.connect();
    await db.transaction(async (tx) => {
      await tx.useCollection("x").insertOne({ v: 1 });
    });
    expect(logs.some(l => /deferred effect failed/.test(l.msg))).toBe(true);
  });

  test("\"throw\" surfaces an AggregateError after commit", async () => {
    const db = new Skalex({
      adapter: new MemoryAdapter(),
      deferredEffectErrors: "throw",
      logger: () => {},
    });
    db.use({
      async afterInsert() { throw new Error("boom"); },
    });
    await db.connect();
    let caught = null;
    try {
      await db.transaction(async (tx) => {
        await tx.useCollection("x").insertOne({ v: 1 });
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    // Data is still committed
    const { docs } = await db.useCollection("x").find({});
    expect(docs).toHaveLength(1);
  });

  test("per-transaction option overrides the instance default", async () => {
    const logs = [];
    const db = new Skalex({
      adapter: new MemoryAdapter(),
      deferredEffectErrors: "warn", // instance default
      logger: (msg) => logs.push(msg),
    });
    db.use({
      async afterInsert() { throw new Error("boom"); },
    });
    await db.connect();

    // Transaction that overrides to "throw" - surfaces the error.
    let caught = null;
    try {
      await db.transaction(async (tx) => {
        await tx.useCollection("x").insertOne({ v: 1 });
      }, { deferredEffectErrors: "throw" });
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(AggregateError);

    // Transaction without override - falls back to instance default "warn",
    // no throw, logs the error.
    logs.length = 0;
    await db.transaction(async (tx) => {
      await tx.useCollection("x").insertOne({ v: 2 });
    });
    expect(logs.some(m => /deferred effect failed/.test(m))).toBe(true);

    // Transaction that overrides to "ignore" - silent, no log, no throw.
    logs.length = 0;
    await db.transaction(async (tx) => {
      await tx.useCollection("x").insertOne({ v: 3 });
    }, { deferredEffectErrors: "ignore" });
    expect(logs.filter(m => /deferred effect failed/.test(m))).toHaveLength(0);
  });

  test("per-transaction deferredEffectErrors rejects invalid strings", async () => {
    const db = makeDb();
    await db.connect();
    await expect(
      db.transaction(async () => {}, { deferredEffectErrors: "warning" })
    ).rejects.toThrow(/Invalid deferredEffectErrors.*transaction/);
    await expect(
      db.transaction(async () => {}, { deferredEffectErrors: "Throw" })
    ).rejects.toThrow(/Invalid deferredEffectErrors/);
  });

  test("constructor deferredEffectErrors rejects invalid strings with a clear message", () => {
    expect(() => new Skalex({
      adapter: new MemoryAdapter(),
      deferredEffectErrors: "warning",
    })).toThrow(/Invalid deferredEffectErrors.*Skalex config/);
  });

  // Contract pin: deferred effects can trigger cascaded non-tx writes, which
  // run through the public (non-proxy) Collection API. Those cascaded writes
  // emit their own events and commit independently of the outer tx because
  // they are themselves non-tx writes. The cascaded events are picked up
  // during the same `for-of` iteration over `ctx.deferredEffects`.
  test("deferred effect may cascade into a non-tx write on another collection", async () => {
    const db = makeDb({ autoSave: true, deferredEffectErrors: "warn", logger: () => {} });
    const order = [];
    db.use({
      async afterInsert({ collection, doc }) {
        order.push(`after:${collection}`);
        if (collection === "primary") {
          // Cascade: insert into "audit" via the real db (non-proxy path).
          await db.useCollection("audit").insertOne({ source: collection, docId: doc._id });
        }
      },
    });
    await db.connect();

    await db.transaction(async (tx) => {
      await tx.useCollection("primary").insertOne({ v: 1 });
    });

    // Both collections are populated (and persisted, since autoSave is on
    // and the cascade went through the non-tx save path).
    const primary = await db.useCollection("primary").find({});
    const audit = await db.useCollection("audit").find({});
    expect(primary.docs).toHaveLength(1);
    expect(audit.docs).toHaveLength(1);
    expect(audit.docs[0].source).toBe("primary");
    // After-insert hooks fired for BOTH inserts - the outer primary insert
    // fired its hook during deferred flush, and the cascaded audit insert
    // fired its hook through the non-tx pipeline path.
    expect(order).toEqual(["after:primary", "after:audit"]);
  });
});

// ─── _txProxyCallDepth behaviour ──────────────────────────────────────────

describe("TransactionManager  -  _txProxyCallDepth", () => {
  test("decrements on sync throw (validation error through proxy does not leak the counter)", async () => {
    const db = makeDb();
    db.createCollection("items", { schema: { name: "string" } });
    await db.connect();
    const col = db.useCollection("items");

    let caught = null;
    try {
      await db.transaction(async (tx) => {
        const items = tx.useCollection("items");
        // This should throw a validation error (number is not a string)
        await items.insertOne({ name: 42 });
      });
    } catch (e) { caught = e; }

    expect(caught).toBeTruthy();
    // Counter must be back to 0 (or undefined) - no leak
    expect(col._txProxyCallDepth || 0).toBe(0);
  });

  test("only wraps mutation methods (find through proxy does NOT elevate counter)", async () => {
    const db = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    await col.insertOne({ name: "Alice" });

    await db.transaction(async (tx) => {
      const items = tx.useCollection("items");
      // find is not a mutation method - depth should stay at 0
      const before = col._txProxyCallDepth || 0;
      await items.find({});
      const after = col._txProxyCallDepth || 0;
      expect(before).toBe(0);
      expect(after).toBe(0);
    });
  });
});

// ─── Mutation method pattern ──────────────────────────────────────────────

describe("TransactionManager  -  mutation method pattern", () => {
  test("pattern matches all current public mutation methods", async () => {
    const { _MUTATION_METHOD_PATTERN } = await import("../../src/engine/transaction.js");
    const mutations = [
      "insertOne", "insertMany", "updateOne", "updateMany",
      "upsert", "upsertMany", "deleteOne", "deleteMany", "restore",
    ];
    for (const m of mutations) {
      expect(_MUTATION_METHOD_PATTERN.test(m)).toBe(true);
    }
  });

  test("pattern does not match reads, aggregations, or internal methods", async () => {
    const { _MUTATION_METHOD_PATTERN } = await import("../../src/engine/transaction.js");
    const nonMutations = [
      "find", "findOne", "count", "sum", "avg", "groupBy",
      "search", "similar", "watch", "export", "applyUpdate",
      "_insertCore", "_updateCore", "_deleteCore", "_buildDoc",
      "constructor", "name",
    ];
    for (const m of nonMutations) {
      expect(_MUTATION_METHOD_PATTERN.test(m)).toBe(false);
    }
  });

  test("new mutation method following the naming convention is automatically covered", async () => {
    const { _MUTATION_METHOD_PATTERN } = await import("../../src/engine/transaction.js");
    // Hypothetical future additions - must match without touching the pattern.
    expect(_MUTATION_METHOD_PATTERN.test("patchMany")).toBe(false); // "patch" is not a registered prefix
    expect(_MUTATION_METHOD_PATTERN.test("insertByKey")).toBe(true);
    expect(_MUTATION_METHOD_PATTERN.test("updateBy")).toBe(true);
    expect(_MUTATION_METHOD_PATTERN.test("upsertWhere")).toBe(true);
    expect(_MUTATION_METHOD_PATTERN.test("deleteByFilter")).toBe(true);
  });
});

// ─── isCollectionLocked ───────────────────────────────────────────────────

describe("TransactionManager  -  isCollectionLocked", () => {
  test("returns false when no tx active", async () => {
    const db = makeDb();
    await db.connect();
    expect(db._txManager.isCollectionLocked("items")).toBe(false);
  });

  test("returns false after commit", async () => {
    const db = makeDb();
    await db.connect();
    await db.transaction(async (tx) => {
      await tx.useCollection("items").insertOne({ v: 1 });
      // During tx, the collection is locked
      expect(db._txManager.isCollectionLocked("items")).toBe(true);
    });
    // After commit, unlocked
    expect(db._txManager.isCollectionLocked("items")).toBe(false);
  });
});

// ─── stats cache cleared on rollback ─────────────────────────────────────

describe("TransactionManager  -  stats cache cleared on rollback", () => {
  test("stats cache is cleared for rolled-back collections", async () => {
    const db = makeDb();
    await db.connect();
    // Insert a doc to create the collection and populate stats
    await db.useCollection("items").insertOne({ v: 1 });
    // Force a stats() call to populate the cache
    if (db._registry?._statsCache) {
      db._registry._statsCache.set("items", { count: 1 });
    }

    let caught = null;
    try {
      await db.transaction(async (tx) => {
        await tx.useCollection("items").insertOne({ v: 2 });
        throw new Error("forced rollback");
      });
    } catch (e) { caught = e; }

    expect(caught).toBeTruthy();
    // Stats cache for "items" must be cleared after rollback
    if (db._registry?._statsCache) {
      expect(db._registry._statsCache.has("items")).toBe(false);
    }
  });
});
