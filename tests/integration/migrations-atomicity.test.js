/**
 * Integration tests for migration atomicity: each migration runs inside
 * its own transaction, and the `appliedVersions` bookkeeping is persisted
 * atomically with the migration's data writes via `saveAtomic`.
 *
 * Failures roll back data AND the version record. Earlier migrations that
 * committed are preserved. Retries start from a clean slate.
 */
import { describe, test, expect } from "vitest";
import Skalex from "../../src/index.js";
import MemoryAdapter from "../helpers/MemoryAdapter.js";

// Helper: decode a persisted _meta blob and return the first doc, or null.
// The on-disk payload is wrapped as `{ data: { data: [...docs], ... }, meta }`
// by the out-of-band type serializer introduced in alpha.6.
async function readMetaDoc(adapter) {
  const raw = await adapter.read("_meta");
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  const payload = parsed?.data ?? parsed;
  return payload?.data?.[0] ?? null;
}

// ─── Rollback + clean retry ───────────────────────────────────────────────

describe("migrations  -  transaction rollback", () => {
  test("partial writes roll back when up() throws; retry starts clean", async () => {
    const adapter = new MemoryAdapter();
    const db1 = new Skalex({ adapter });
    db1.addMigration({
      version: 1,
      up: async (txDb) => {
        await txDb.useCollection("items").insertOne({ n: 1 });
        throw new Error("migration fails");
      },
    });
    await expect(db1.connect()).rejects.toThrow(/migration fails/);
    // In-memory state: the transaction rolled back and removed the collection
    // that was created inside it.
    expect(db1.collections.items).toBeUndefined();
    // Persistence: saveAtomic never ran because the transaction rejected.
    expect(await adapter.read("items")).toBe(null);

    // A fresh instance with a clean (non-throwing) migration runs from a
    // pristine state - the retry is not contaminated by the previous partial.
    const db2 = new Skalex({ adapter });
    db2.addMigration({
      version: 1,
      up: async (txDb) => {
        await txDb.useCollection("items").insertOne({ n: 2 });
      },
    });
    await db2.connect();
    const { docs } = await db2.useCollection("items").find({});
    expect(docs).toHaveLength(1);
    expect(docs[0].n).toBe(2);
    await db2.disconnect();
  });

  test("earlier migrations commit even when a later one fails", async () => {
    const adapter = new MemoryAdapter();
    const db = new Skalex({ adapter });
    db.addMigration({
      version: 1,
      up: async (txDb) => {
        await txDb.useCollection("a").insertOne({ x: 1 });
      },
    });
    db.addMigration({
      version: 2,
      up: async (txDb) => {
        await txDb.useCollection("b").insertOne({ y: 2 });
        throw new Error("migration 2 fails");
      },
    });
    await expect(db.connect()).rejects.toThrow(/migration 2 fails/);
    // Migration 1 committed in its own transaction.
    expect(db.collections.a).toBeDefined();
    expect(db.collections.a.data).toHaveLength(1);
    expect(await adapter.read("a")).not.toBe(null);
    // Migration 2 rolled back - collection was created inside its tx.
    expect(db.collections.b).toBeUndefined();
    expect(await adapter.read("b")).toBe(null);
  });
});

// ─── Atomic _meta bookkeeping ─────────────────────────────────────────────

describe("migrations  -  atomic _meta bookkeeping", () => {
  test("applied version reaches disk atomically with migration data", async () => {
    const adapter = new MemoryAdapter();
    const db1 = new Skalex({ adapter });
    db1.addMigration({
      version: 1,
      up: async (txDb) => {
        await txDb.useCollection("users").insertOne({ name: "Alice" });
      },
    });
    await db1.connect();

    // _meta was persisted as part of migration 1's saveAtomic batch.
    // Inspect the raw adapter state to confirm, not just the in-memory view.
    const metaDoc = await readMetaDoc(adapter);
    expect(metaDoc).not.toBeNull();
    expect(metaDoc.appliedVersions).toEqual([1]);

    const usersRaw = await adapter.read("users");
    expect(usersRaw).not.toBe(null);
  });

  test("migration is NOT re-run on a fresh instance", async () => {
    const adapter = new MemoryAdapter();
    let runs = 0;

    const db1 = new Skalex({ adapter });
    db1.addMigration({
      version: 1,
      up: async (txDb) => {
        runs++;
        await txDb.useCollection("seeds").insertOne({ i: 1 });
      },
    });
    await db1.connect();
    await db1.disconnect();
    expect(runs).toBe(1);

    // Same migration, fresh Skalex instance over the same adapter.
    // The version record persisted in step 1 must prevent a re-run.
    const db2 = new Skalex({ adapter });
    db2.addMigration({
      version: 1,
      up: async (txDb) => {
        runs++;
        await txDb.useCollection("seeds").insertOne({ i: 2 });
      },
    });
    await db2.connect();
    const { docs } = await db2.useCollection("seeds").find({});
    expect(runs).toBe(1); // second run skipped
    expect(docs).toHaveLength(1);
    expect(docs[0].i).toBe(1);
  });

  test("failed migration does not persist its version, retry from clean state", async () => {
    const adapter = new MemoryAdapter();

    const db1 = new Skalex({ adapter });
    db1.addMigration({
      version: 1,
      up: async (txDb) => {
        await txDb.useCollection("items").insertOne({ n: 1 });
        throw new Error("first attempt fails");
      },
    });
    await expect(db1.connect()).rejects.toThrow(/first attempt/);

    // No _meta / no items should have persisted - the tx rolled back.
    expect(await adapter.read("items")).toBe(null);
    const metaDoc = await readMetaDoc(adapter);
    // Meta may or may not exist depending on whether a prior connect wrote
    // the flush sentinel; either way, appliedVersions must not include 1.
    if (metaDoc) {
      expect(metaDoc.appliedVersions ?? []).not.toContain(1);
    }

    // Fresh instance + fixed migration must run from scratch.
    const db2 = new Skalex({ adapter });
    db2.addMigration({
      version: 1,
      up: async (txDb) => {
        await txDb.useCollection("items").insertOne({ n: 2 });
      },
    });
    await db2.connect();
    const { docs } = await db2.useCollection("items").find({});
    expect(docs).toHaveLength(1);
    expect(docs[0].n).toBe(2);
    expect((await readMetaDoc(adapter)).appliedVersions).toEqual([1]);
  });

  test("crash between migrations leaves an atomic prefix applied", async () => {
    // Simulate the "migration 1 commits, process dies, reopen with both
    // migrations registered" scenario. Only migration 2 should run.
    const adapter = new MemoryAdapter();

    const db1 = new Skalex({ adapter });
    db1.addMigration({
      version: 1,
      up: async (txDb) => {
        await txDb.useCollection("a").insertOne({ v: 1 });
      },
    });
    await db1.connect();
    await db1.disconnect();

    // New instance with BOTH migrations; only 2 should actually execute.
    const ran = [];
    const db2 = new Skalex({ adapter });
    db2.addMigration({
      version: 1,
      up: async () => { ran.push(1); },
    });
    db2.addMigration({
      version: 2,
      up: async (txDb) => {
        ran.push(2);
        await txDb.useCollection("b").insertOne({ v: 2 });
      },
    });
    await db2.connect();

    expect(ran).toEqual([2]); // migration 1 skipped (already applied)
    const { docs: aDocs } = await db2.useCollection("a").find({});
    const { docs: bDocs } = await db2.useCollection("b").find({});
    expect(aDocs).toHaveLength(1);
    expect(bDocs).toHaveLength(1);
    expect((await readMetaDoc(adapter)).appliedVersions).toEqual([1, 2]);
  });

  test("read-only migration still persists its version record", async () => {
    const adapter = new MemoryAdapter();

    // Pre-seed with some data so the migration has something to read.
    const db0 = new Skalex({ adapter });
    await db0.connect();
    await db0.useCollection("users").insertOne({ name: "seed" }, { save: true });
    await db0.disconnect();

    const db1 = new Skalex({ adapter });
    db1.addMigration({
      version: 1,
      up: async (txDb) => {
        // Read-only migration: doesn't mutate any user collection.
        const col = txDb.useCollection("users");
        const { docs } = await col.find({});
        expect(docs).toHaveLength(1);
      },
    });
    await db1.connect();

    // Even though no user collection was touched, _meta must be persisted
    // so the version record isn't lost. snapshotIfNeeded("_meta", ...)
    // adds _meta to touchedCollections, keeping the tx commit path active.
    const metaDoc = await readMetaDoc(adapter);
    expect(metaDoc.appliedVersions).toEqual([1]);
  });
});

// ─── Defensive invariant ──────────────────────────────────────────────────

describe("migrations  -  _recordAppliedVersions invariant", () => {
  test("throws when called outside an active transaction", async () => {
    // The atomicity contract depends on running inside a transaction so
    // _meta can be snapshotted into it. Calling this helper outside a tx
    // would silently regress to the pre-alpha.3 "marked dirty but maybe
    // never flushed" bug - the guard turns that into a visible error.
    const db = new Skalex({ adapter: new MemoryAdapter() });
    await db.connect();
    expect(() => db._recordAppliedVersions([1])).toThrow(/must be called inside an active transaction/);
  });
});
