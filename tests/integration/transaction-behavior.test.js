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
