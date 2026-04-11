/**
 * Persistence coherence regression tests (P1).
 *
 * Covers:
 *   #8   saveAtomic includes _meta in batch (no memory/disk divergence)
 *   #9   save() best-effort semantics (partial failure documented)
 *   #10  Save mutex serializes saveAtomic against concurrent saves
 *   #11  FieldIndex.update() restores old doc on re-index failure
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, existsSync, promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import nodeFs from "node:fs";
import Skalex from "../../src/index.js";
import MemoryAdapter from "../helpers/MemoryAdapter.js";
import FsAdapter from "../../src/connectors/storage/fs.js";

function makeDb(opts = {}) {
  const adapter = new MemoryAdapter();
  return { db: new Skalex({ adapter, ...opts }), adapter };
}

// ─── #11  Index update atomicity ───────────────────────────────────────────

describe("FieldIndex.update() atomicity", () => {
  test("failed re-index restores old document in index", async () => {
    const { db } = makeDb();
    await db.connect();
    db.createCollection("users", {
      schema: {
        email: { type: "string", unique: true },
        name: "string",
      },
    });
    const col = db.useCollection("users");

    await col.insertOne({ email: "alice@test.com", name: "Alice" });
    await col.insertOne({ email: "bob@test.com", name: "Bob" });

    // Attempt to update Alice's email to Bob's (unique violation)
    await expect(
      col.updateOne({ email: "alice@test.com" }, { email: "bob@test.com" })
    ).rejects.toThrow(/unique/i);

    // Alice should still be findable by her original email via index
    const alice = await col.findOne({ email: "alice@test.com" });
    expect(alice).not.toBeNull();
    expect(alice.name).toBe("Alice");

    // Bob should still be findable
    const bob = await col.findOne({ email: "bob@test.com" });
    expect(bob).not.toBeNull();
    expect(bob.name).toBe("Bob");
    await db.disconnect();
  });

  test("successful update removes old value from index", async () => {
    const { db } = makeDb();
    await db.connect();
    db.createCollection("users", {
      schema: { email: { type: "string", unique: true } },
    });
    const col = db.useCollection("users");

    await col.insertOne({ email: "alice@test.com" });
    await col.updateOne({ email: "alice@test.com" }, { email: "alice-new@test.com" });

    const old = await col.findOne({ email: "alice@test.com" });
    expect(old).toBeNull();

    const found = await col.findOne({ email: "alice-new@test.com" });
    expect(found).not.toBeNull();
    await db.disconnect();
  });
});

// ─── #8  saveAtomic includes _meta in batch ───────────────────────────────

describe("saveAtomic memory/disk coherence", () => {
  test("_meta is included in the writeAll batch", async () => {
    const adapter = new MemoryAdapter();
    const batchEntryNames = [];
    const originalWriteAll = adapter.writeAll.bind(adapter);

    adapter.writeAll = async (entries) => {
      batchEntryNames.push(...entries.map(e => e.name));
      return originalWriteAll(entries);
    };

    const db = new Skalex({ adapter });
    await db.connect();

    await db.transaction(async (tx) => {
      await tx.useCollection("items").insertOne({ x: 1 });
    });

    expect(batchEntryNames).toContain("_meta");
    expect(batchEntryNames).toContain("items");
    await db.disconnect();
  });

  test("full batch failure throws and does not corrupt disk", async () => {
    const adapter = new MemoryAdapter();
    let failWriteAll = false;
    const originalWriteAll = adapter.writeAll.bind(adapter);

    adapter.writeAll = async (entries) => {
      if (failWriteAll) throw new Error("disk full");
      return originalWriteAll(entries);
    };

    const db = new Skalex({ adapter });
    await db.connect();
    await db.useCollection("items").insertOne({ x: 1 }, { save: true });

    // Force the batch to fail
    failWriteAll = true;
    await expect(
      db.transaction(async (tx) => {
        await tx.useCollection("items").insertOne({ x: 2 });
      })
    ).rejects.toThrow(/batch save failed/i);

    // Reload - original data should be intact (batch failed atomically)
    failWriteAll = false;
    const db2 = new Skalex({ adapter });
    await db2.connect();
    const { docs } = await db2.useCollection("items").find({});
    expect(docs).toHaveLength(1);
    expect(docs[0].x).toBe(1);
    await db2.disconnect();
    await db.disconnect();
  });

  test("sentinel clear failure logs warning without throwing", async () => {
    const adapter = new MemoryAdapter();
    const originalWrite = adapter.write.bind(adapter);

    // Track _meta writes: writeAll handles the batch (including _meta),
    // then a separate write("_meta", ...) clears the sentinel.
    // We want to fail only that post-batch sentinel clear.
    let metaWriteCount = 0;
    adapter.write = async (name, data) => {
      if (name === "_meta") {
        metaWriteCount++;
        // Fail the sentinel-clear write (occurs after writeAll succeeds)
        if (metaWriteCount >= 2) throw new Error("sentinel clear failed");
      }
      return originalWrite(name, data);
    };

    const db = new Skalex({ adapter });
    await db.connect();

    const logged = [];
    const origError = console.error;
    console.error = (msg) => logged.push(msg);

    // Transaction: batch succeeds via writeAll, but sentinel clear fails
    await db.transaction(async (tx) => {
      await tx.useCollection("items").insertOne({ x: 1 });
    });

    console.error = origError;

    const hasWarning = logged.some(m =>
      typeof m === "string" && m.includes("sentinel clear failed")
    );
    expect(hasWarning).toBe(true);

    // Data should still be committed (batch succeeded)
    const { docs } = await db.useCollection("items").find({});
    expect(docs).toHaveLength(1);

    // Reset mock before disconnect (which calls saveData)
    adapter.write = originalWrite;
    await db.disconnect();
  });
});

// ─── #9  save() best-effort semantics ─────────────────────────────────────

describe("save() best-effort semantics", () => {
  test("partial failure persists successful collections", async () => {
    const adapter = new MemoryAdapter();
    let failCollection = null;
    const originalWrite = adapter.write.bind(adapter);

    adapter.write = async (name, data) => {
      if (name === failCollection) throw new Error(`write failed for ${name}`);
      return originalWrite(name, data);
    };

    const db = new Skalex({ adapter });
    await db.connect();
    await db.useCollection("a").insertOne({ x: 1 });
    await db.useCollection("b").insertOne({ y: 2 });

    failCollection = "b";
    await expect(db.saveData()).rejects.toThrow(/write failed/);

    // Collection "a" should have been persisted despite "b" failing
    failCollection = null;
    const db2 = new Skalex({ adapter });
    await db2.connect();
    const { docs: aDocs } = await db2.useCollection("a").find({});
    expect(aDocs).toHaveLength(1);
    await db2.disconnect();
  });
});

// ─── #10  Save mutex ──────────────────────────────────────────────────────

describe("save mutex serializes saveAtomic calls", () => {
  test("concurrent transactions serialize their saveAtomic commits", async () => {
    const adapter = new MemoryAdapter();
    const batchOps = [];
    const originalWriteAll = adapter.writeAll.bind(adapter);

    adapter.writeAll = async (entries) => {
      const names = entries.map(e => e.name).sort();
      batchOps.push({ names, phase: "start" });
      await new Promise(r => setTimeout(r, 30));
      const result = await originalWriteAll(entries);
      batchOps.push({ names, phase: "end" });
      return result;
    };

    const db = new Skalex({ adapter });
    await db.connect();

    // Two concurrent transactions touching different collections
    await Promise.all([
      db.transaction(async (tx) => {
        await tx.useCollection("a").insertOne({ x: 1 });
      }),
      db.transaction(async (tx) => {
        await tx.useCollection("b").insertOne({ y: 2 });
      }),
    ]);

    // Verify serialization: first batch must end before second starts.
    // _txLock serializes the transaction callbacks, and _saveLock
    // serializes the saveAtomic calls within each commit.
    const starts = batchOps.filter(o => o.phase === "start");
    const ends = batchOps.filter(o => o.phase === "end");

    expect(starts).toHaveLength(2);
    expect(ends).toHaveLength(2);

    // First batch end must come before second batch start
    const firstEndIdx = batchOps.indexOf(ends[0]);
    const secondStartIdx = batchOps.indexOf(starts[1]);
    expect(firstEndIdx).toBeLessThan(secondStartIdx);

    await db.disconnect();
  });

  test("per-collection write coalescing still works under concurrent inserts", async () => {
    let writeCount = 0;
    const adapter = new MemoryAdapter();
    const originalWrite = adapter.write.bind(adapter);

    adapter.write = async (name, data) => {
      if (name === "items") writeCount++;
      await new Promise(r => setTimeout(r, 30));
      return originalWrite(name, data);
    };

    const db = new Skalex({ adapter });
    await db.connect();
    const col = db.useCollection("items");

    // Fire 3 concurrent save:true inserts
    const [a, b, c] = await Promise.all([
      col.insertOne({ x: 1 }, { save: true }),
      col.insertOne({ x: 2 }, { save: true }),
      col.insertOne({ x: 3 }, { save: true }),
    ]);

    expect(a.x).toBe(1);
    expect(b.x).toBe(2);
    expect(c.x).toBe(3);

    // Write coalescing should reduce the number of adapter writes
    // below the number of callers (3 inserts but fewer actual writes)
    expect(writeCount).toBeLessThan(3);

    // All data should be on disk
    const db2 = new Skalex({ adapter });
    await db2.connect();
    const { docs } = await db2.useCollection("items").find({});
    expect(docs).toHaveLength(3);
    await db2.disconnect();
    await db.disconnect();
  });

  test("data is consistent after concurrent save and transaction", async () => {
    const adapter = new MemoryAdapter();
    const db = new Skalex({ adapter });
    await db.connect();
    await db.useCollection("items").insertOne({ x: 1 }, { save: true });

    await Promise.all([
      db.saveData(),
      db.transaction(async (tx) => {
        await tx.useCollection("items").insertOne({ x: 2 });
      }),
    ]);

    // Verify on reload
    const db2 = new Skalex({ adapter });
    await db2.connect();
    const { docs } = await db2.useCollection("items").find({});
    expect(docs).toHaveLength(2);
    await db2.disconnect();
    await db.disconnect();
  });

  test("concurrent saveDirty (autoSave) and transaction commit produce no data loss", async () => {
    const adapter = new MemoryAdapter();
    const db = new Skalex({ adapter, autoSave: true });
    await db.connect();

    // Seed two collections - one will be touched by the tx, the other by autoSave
    const items = db.useCollection("items");
    const logs = db.useCollection("logs");
    await items.insertOne({ x: 1 }, { save: true });

    // Non-tx insert triggers autoSave (saveDirty path) while tx commit
    // runs saveAtomic concurrently. Both touch different collections.
    const txPromise = db.transaction(async (tx) => {
      await tx.useCollection("items").insertOne({ x: 2 });
    });
    // autoSave insert fires saveDirty for "logs" during the tx await
    const autoSavePromise = logs.insertOne({ msg: "hello" });

    await Promise.all([txPromise, autoSavePromise]);

    // Verify all data survived on reload
    const db2 = new Skalex({ adapter });
    await db2.connect();
    const { docs: itemDocs } = await db2.useCollection("items").find({});
    const { docs: logDocs } = await db2.useCollection("logs").find({});
    expect(itemDocs).toHaveLength(2);
    expect(logDocs).toHaveLength(1);
    await db2.disconnect();
    await db.disconnect();
  });
});

// ─── _meta managed via PersistenceManager ─────────────────────────────────

describe("PersistenceManager  -  _meta ownership", () => {
  test("getMeta / updateMeta round-trip", async () => {
    const { db } = makeDb();
    await db.connect();
    db._persistence.updateMeta(db.collections, { custom: "value" });
    const meta = db._persistence.getMeta(db.collections);
    expect(meta.custom).toBe("value");
    expect(db.collections._meta).toBeDefined();
  });

  test("_meta store shape matches registry.createStore() output", async () => {
    const { db } = makeDb();
    await db.connect();
    db._persistence.updateMeta(db.collections, { foo: 1 });
    const metaStore = db.collections._meta;
    expect(metaStore.collectionName).toBe("_meta");
    expect(metaStore.index).toBeInstanceOf(Map);
    expect(metaStore.data).toBeInstanceOf(Array);
    expect("_dirty" in metaStore).toBe(true);
    expect("fieldIndex" in metaStore).toBe(true);
    expect("schema" in metaStore).toBe(true);
    expect("onSchemaError" in metaStore).toBe(true);
    expect("maxDocs" in metaStore).toBe(true);
  });
});

// ─── Orphan cleanup lives on the adapter ──────────────────────────────────

describe("PersistenceManager  -  orphan cleanup delegation", () => {
  test("delegates to adapter.cleanOrphans on load", async () => {
    const { db } = makeDb();
    let called = false;
    db.fs.cleanOrphans = async () => { called = true; return 0; };
    await db.connect();
    expect(called).toBe(true);
  });
});

// ─── FsAdapter rename failure + orphan recovery ───────────────────────────

describe("FsAdapter  -  rename failure + orphan recovery", () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(nodePath.join(tmpdir(), "skalex-fs-"));
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test("writeAll that fails during rename leaves temp files that cleanOrphans removes", async () => {
    const adapter = new FsAdapter({ dir, format: "json" });
    const originalRename = nodeFs.promises.rename;
    let renameCalls = 0;
    nodeFs.promises.rename = async (...args) => {
      renameCalls++;
      // Fail on the first rename attempt to abort the batch mid-commit.
      if (renameCalls === 1) throw new Error("injected rename failure");
      return originalRename(...args);
    };

    try {
      await expect(
        adapter.writeAll([
          { name: "a", data: JSON.stringify({ collectionName: "a", data: [] }) },
          { name: "b", data: JSON.stringify({ collectionName: "b", data: [] }) },
        ])
      ).rejects.toThrow(/injected rename failure/);
    } finally {
      nodeFs.promises.rename = originalRename;
    }

    // Staging wrote temp files; since rename failed, writeAll's catch block
    // best-effort-unlinked them. Depending on ordering, some may remain.
    // In any case, cleanOrphans must leave zero `.tmp.` files.
    await adapter.cleanOrphans();
    const remaining = readdirSync(dir).filter((f) => f.includes(".tmp."));
    expect(remaining).toHaveLength(0);
  });

  test("cleanOrphans removes manually planted temp files", async () => {
    const adapter = new FsAdapter({ dir, format: "json" });
    // Plant a fake orphan by hand
    const orphan = nodePath.join(dir, "foo_abc.tmp.json");
    await fsp.writeFile(orphan, "partial");
    expect(existsSync(orphan)).toBe(true);
    const removed = await adapter.cleanOrphans();
    expect(removed).toBe(1);
    expect(existsSync(orphan)).toBe(false);
  });
});
