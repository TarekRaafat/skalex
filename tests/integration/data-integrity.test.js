/**
 * Alpha.2 Phase 1 (P0) regression tests.
 *
 * Covers:
 *   #1  Stale Collection instances after createCollection -> connect
 *   #2  Upsert operator leak into inserted documents
 *   #3  insertMany unique index corruption on partial batch failure
 *   #4  Non-transactional writes not captured by active transaction
 *   #5  Stale transaction proxy throws after commit/timeout
 *   #6  { save: true } awaits actual disk write
 *   #7  ChangeLog.restore() persists restored state
 */
import { describe, test, expect } from "vitest";
import Skalex from "../../src/index.js";
import MemoryAdapter from "../helpers/MemoryAdapter.js";

function makeDb(opts = {}) {
  const adapter = new MemoryAdapter();
  return { db: new Skalex({ adapter, ...opts }), adapter };
}

// ─── #1  Stale Collection instances ────────────────────────────────────────

describe("#1 stale Collection instances after createCollection -> connect", () => {
  test("useCollection returns loaded data after createCollection + connect", async () => {
    const adapter = new MemoryAdapter();

    // First session: seed data to disk
    const db1 = new Skalex({ adapter });
    await db1.connect();
    const col1 = db1.useCollection("users");
    await col1.insertOne({ name: "Alice" }, { save: true });
    await db1.disconnect();

    // Second session: createCollection before connect, then verify loaded data
    const db2 = new Skalex({ adapter });
    db2.createCollection("users", { schema: { name: "string" } });
    await db2.connect();

    const col2 = db2.useCollection("users");
    const { docs } = await col2.find({});
    expect(docs).toHaveLength(1);
    expect(docs[0].name).toBe("Alice");
    await db2.disconnect();
  });

  test("insertOne with save:true does not overwrite pre-existing data", async () => {
    const adapter = new MemoryAdapter();

    // Seed
    const db1 = new Skalex({ adapter });
    await db1.connect();
    await db1.useCollection("items").insertOne({ x: 1 }, { save: true });
    await db1.disconnect();

    // createCollection before connect, then insert
    const db2 = new Skalex({ adapter });
    db2.createCollection("items");
    await db2.connect();

    const col = db2.useCollection("items");
    await col.insertOne({ x: 2 }, { save: true });

    const { docs } = await col.find({});
    expect(docs).toHaveLength(2);
    await db2.disconnect();
  });
});

// ─── #2  Upsert operator leak ──────────────────────────────────────────────

describe("#2 upsert operator leak", () => {
  test("upsert with $eq filter stores resolved plain value", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("users");

    const result = await col.upsert({ email: { $eq: "alice@test.com" } }, { name: "Alice" });
    expect(result.email).toBe("alice@test.com");
    expect(typeof result.email).toBe("string");
    await db.disconnect();
  });

  test("upsert with range operator omits non-resolvable fields", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("users");

    const result = await col.upsert({ age: { $gt: 18 } }, { name: "Bob" });
    expect(result.name).toBe("Bob");
    expect(result.age).toBeUndefined();
    await db.disconnect();
  });

  test("upsert with plain filter works unchanged", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("users");

    const result = await col.upsert({ email: "plain@test.com" }, { name: "Carol" });
    expect(result.email).toBe("plain@test.com");
    expect(result.name).toBe("Carol");
    await db.disconnect();
  });

  test("upsert round-trip survives disconnect/reconnect", async () => {
    const adapter = new MemoryAdapter();
    const db1 = new Skalex({ adapter });
    await db1.connect();
    const col1 = db1.useCollection("users");
    await col1.upsert({ email: { $eq: "test@test.com" } }, { name: "Dave" }, { save: true });
    await db1.disconnect();

    const db2 = new Skalex({ adapter });
    await db2.connect();
    const col2 = db2.useCollection("users");
    const doc = await col2.findOne({ email: "test@test.com" });
    expect(doc).not.toBeNull();
    expect(doc.email).toBe("test@test.com");
    expect(typeof doc.email).toBe("string");
    await db2.disconnect();
  });
});

// ─── #3  insertMany index corruption ───────────────────────────────────────

describe("#3 insertMany unique index corruption on partial failure", () => {
  test("duplicate unique field in batch throws and leaves no ghost entries", async () => {
    const { db } = makeDb();
    await db.connect();
    db.createCollection("users", {
      schema: { email: { type: "string", unique: true } },
    });
    const col = db.useCollection("users");

    await expect(
      col.insertMany([{ email: "a@test.com" }, { email: "a@test.com" }])
    ).rejects.toThrow(/unique/i);

    // Collection should have 0 docs - no partial insert
    const { docs } = await col.find({});
    expect(docs).toHaveLength(0);

    // Subsequent insert with the same value must succeed (no ghost index entry)
    const inserted = await col.insertOne({ email: "a@test.com" });
    expect(inserted.email).toBe("a@test.com");
    await db.disconnect();
  });

  test("insertMany with distinct unique values succeeds", async () => {
    const { db } = makeDb();
    await db.connect();
    db.createCollection("users", {
      schema: { email: { type: "string", unique: true } },
    });
    const col = db.useCollection("users");

    const results = await col.insertMany([
      { email: "a@test.com" },
      { email: "b@test.com" },
    ]);
    expect(results).toHaveLength(2);
    await db.disconnect();
  });
});

// ─── #4  Non-tx writes not captured by rollback ───────────────────────────

describe("#4 non-transactional writes during active transaction", () => {
  test("non-tx write to untouched collection survives transaction rollback", async () => {
    const { db } = makeDb();
    await db.connect();
    const outside = db.useCollection("outside");

    try {
      await db.transaction(async (tx) => {
        await tx.useCollection("items").insertOne({ source: "tx" });
        // Non-tx write to a DIFFERENT collection via the real db (not the proxy).
        // This collection is not touched by the transaction, so it should not
        // be snapshotted or rolled back.
        await outside.insertOne({ source: "non-tx" });
        throw new Error("force rollback");
      });
    } catch (e) {
      if (e.message !== "force rollback") throw e;
    }

    // The tx-touched collection should be rolled back
    const { docs: txDocs } = await db.useCollection("items").find({});
    expect(txDocs).toHaveLength(0);

    // The non-tx collection must survive
    const { docs: nonTxDocs } = await outside.find({});
    expect(nonTxDocs).toHaveLength(1);
    expect(nonTxDocs[0].source).toBe("non-tx");
    await db.disconnect();
  });

  test("tx insert is rolled back on failure", async () => {
    const { db } = makeDb();
    await db.connect();

    try {
      await db.transaction(async (tx) => {
        await tx.useCollection("items").insertOne({ x: 1 });
        throw new Error("rollback");
      });
    } catch { }

    const col = db.useCollection("items");
    const { docs } = await col.find({});
    expect(docs).toHaveLength(0);
    await db.disconnect();
  });

  test("non-transaction insert works unchanged", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    await col.insertOne({ x: 1 });

    const { docs } = await col.find({});
    expect(docs).toHaveLength(1);
    await db.disconnect();
  });
});

// ─── #5  Stale transaction proxy ───────────────────────────────────────────

describe("#5 stale transaction proxy after commit/timeout", () => {
  test("proxy throws ERR_SKALEX_TX_STALE_PROXY after commit", async () => {
    const { db } = makeDb();
    await db.connect();

    let capturedProxy;
    await db.transaction(async (tx) => {
      capturedProxy = tx;
      await tx.useCollection("items").insertOne({ x: 1 });
    });

    // Using the proxy after commit should throw
    expect(() => capturedProxy.useCollection("items")).toThrow(/has ended/i);
    await db.disconnect();
  });

  test("proxy throws after timeout", async () => {
    const { db } = makeDb();
    await db.connect();

    let capturedProxy;
    try {
      await db.transaction(async (tx) => {
        capturedProxy = tx;
        await new Promise(r => setTimeout(r, 200));
      }, { timeout: 30 });
    } catch { }

    expect(() => capturedProxy.useCollection("items")).toThrow(/has ended/i);
    await db.disconnect();
  });

  test("proxy works normally during transaction", async () => {
    const { db } = makeDb();
    await db.connect();

    await db.transaction(async (tx) => {
      const col = tx.useCollection("items");
      await col.insertOne({ x: 1 });
      const { docs } = await col.find({});
      expect(docs).toHaveLength(1);
    });

    await db.disconnect();
  });
});

// ─── #6  Save durability ───────────────────────────────────────────────────

describe("#6 save:true awaits actual disk write", () => {
  test("concurrent saves both await actual persistence", async () => {
    let writeCount = 0;
    const adapter = new MemoryAdapter();
    const originalWrite = adapter.write.bind(adapter);

    // Slow adapter to create write contention
    adapter.write = async (name, data) => {
      writeCount++;
      await new Promise(r => setTimeout(r, 50));
      return originalWrite(name, data);
    };

    const db = new Skalex({ adapter });
    await db.connect();
    const col = db.useCollection("items");

    // Fire two concurrent inserts with save:true
    const [a, b] = await Promise.all([
      col.insertOne({ x: 1 }, { save: true }),
      col.insertOne({ x: 2 }, { save: true }),
    ]);

    expect(a.x).toBe(1);
    expect(b.x).toBe(2);

    // Both inserts must be on disk after both promises resolve
    const db2 = new Skalex({ adapter });
    await db2.connect();
    const { docs } = await db2.useCollection("items").find({});
    expect(docs).toHaveLength(2);
    await db2.disconnect();
    await db.disconnect();
  });
});

// ─── #7  ChangeLog.restore() persistence ───────────────────────────────────

describe("#7 changelog restore persists to disk", () => {
  test("restored state survives disconnect/reconnect", async () => {
    const adapter = new MemoryAdapter();
    const db1 = new Skalex({ adapter });
    await db1.connect();

    db1.createCollection("items", { changelog: true });
    const col1 = db1.useCollection("items");

    await col1.insertOne({ name: "Alice" }, { save: true });
    await new Promise(r => setTimeout(r, 10));

    const beforeDelete = new Date();
    await new Promise(r => setTimeout(r, 10));

    await col1.insertOne({ name: "Bob" }, { save: true });
    await col1.deleteOne({ name: "Alice" }, { save: true });

    // Restore to before the delete - should have Alice, not Bob (only Alice existed then)
    await db1.restore("items", beforeDelete);
    await db1.disconnect();

    // Reconnect and verify restored state persisted
    const db2 = new Skalex({ adapter });
    await db2.connect();
    const col2 = db2.useCollection("items");
    const { docs } = await col2.find({});

    const names = docs.map(d => d.name).sort();
    expect(names).toContain("Alice");
    expect(names).not.toContain("Bob");
    await db2.disconnect();
  });
});
