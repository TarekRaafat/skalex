/**
 * Integration tests for observable transaction behaviour:
 * isolation semantics, visibility of outside-the-tx mutations, and any
 * other contract that requires exercising the full Skalex stack.
 *
 * Unit-level tests for TransactionManager (timeout, pruning, nested
 * detection, deferred-effect strategies) live in tests/unit/transaction.test.js.
 */
import { describe, test, expect } from "vitest";
import Skalex from "../../src/index.js";
import MemoryAdapter from "../helpers/MemoryAdapter.js";

function makeDb(opts = {}) {
  return new Skalex({ adapter: new MemoryAdapter(), ...opts });
}

// ─── Read-committed isolation ─────────────────────────────────────────────

describe("transactions  -  read-committed isolation", () => {
  test("reads on un-written collections see external mutations inside a tx", async () => {
    const db = makeDb();
    await db.connect();
    const outsideCol = db.useCollection("logs");
    await outsideCol.insertOne({ v: 1 });

    let secondRead = null;
    await db.transaction(async (tx) => {
      // First read inside the tx, without writing - no snapshot taken.
      const col = tx.useCollection("logs");
      const first = await col.find({});
      expect(first.docs).toHaveLength(1);

      // Mutate collection from OUTSIDE the transaction (via the raw db).
      await outsideCol.insertOne({ v: 2 });

      // Second read inside the tx sees the external mutation (read-committed).
      secondRead = await col.find({});
    });
    expect(secondRead.docs).toHaveLength(2);
  });
});

// ─── Collection-level locking during transactions ─────────────────────────

describe("transactions - collection-level locking", () => {
  test("non-tx write to a tx-touched collection is rejected", async () => {
    const db = makeDb();
    await db.connect();

    // Pre-populate so the tx touches "items" on first write
    const items = db.useCollection("items");
    await items.insertOne({ v: 0 });

    let writeError = null;
    await db.transaction(async (tx) => {
      const txItems = tx.useCollection("items");
      await txItems.insertOne({ v: 1 });

      // Outside the tx, attempt a write to the same collection
      try {
        await items.insertOne({ v: 2 });
      } catch (err) {
        writeError = err;
      }
    });

    expect(writeError).not.toBeNull();
    expect(writeError.code).toBe("ERR_SKALEX_TX_COLLECTION_LOCKED");
  });

  test("non-tx write succeeds after tx commits", async () => {
    const db = makeDb();
    await db.connect();
    const items = db.useCollection("items");

    await db.transaction(async (tx) => {
      await tx.useCollection("items").insertOne({ v: 1 });
    });

    // After commit, collection is unlocked
    await items.insertOne({ v: 2 });
    const all = await items.find({});
    expect(all.docs).toHaveLength(2);
  });

  test("non-tx write succeeds after tx rolls back", async () => {
    const db = makeDb();
    await db.connect();
    const items = db.useCollection("items");

    try {
      await db.transaction(async (tx) => {
        await tx.useCollection("items").insertOne({ v: 1 });
        throw new Error("force rollback");
      });
    } catch { /* expected */ }

    // After rollback, collection is unlocked
    await items.insertOne({ v: 2 });
    const all = await items.find({});
    expect(all.docs).toHaveLength(1);
    expect(all.docs[0].v).toBe(2);
  });

  test("writes to a different collection during tx are not blocked", async () => {
    const db = makeDb();
    await db.connect();

    await db.transaction(async (tx) => {
      await tx.useCollection("items").insertOne({ v: 1 });

      // Write to a different, untouched collection should succeed
      const other = db.useCollection("other");
      await other.insertOne({ v: 2 });
    });

    const other = await db.useCollection("other").find({});
    expect(other.docs).toHaveLength(1);
  });

  test("reads on a locked collection are not blocked", async () => {
    const db = makeDb();
    await db.connect();
    const items = db.useCollection("items");
    await items.insertOne({ v: 0 });

    await db.transaction(async (tx) => {
      await tx.useCollection("items").insertOne({ v: 1 });

      // Read on the same collection via non-tx handle should work
      const result = await items.findOne({ v: 0 });
      expect(result).not.toBeNull();
      expect(result.v).toBe(0);
    });
  });
});
