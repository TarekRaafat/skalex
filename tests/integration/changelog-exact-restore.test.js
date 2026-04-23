/**
 * Regression tests for exact changelog restore (alpha.6).
 *
 * Pre-alpha.6, `db.restore(...)` replayed through `insertOne` / `updateOne`,
 * which regenerated `createdAt`, `updatedAt`, `_version`, and `_expiresAt`
 * with current values. Restored documents therefore did NOT faithfully
 * represent their archived state.
 *
 * After alpha.6, restore rehydrates the archived snapshot directly via the
 * collection's internal `_rehydrateOne` / `_rehydrateAll` paths, preserving
 * every system field exactly.
 */
import { describe, test, expect } from "vitest";
import Skalex from "../../src/index.js";
import MemoryAdapter from "../helpers/MemoryAdapter.js";

// Helper to pause just long enough that `new Date()` monotonically advances.
const tick = () => new Promise(r => setTimeout(r, 5));

describe("changelog restore - exact rehydrate", () => {
  test("restoring a document preserves createdAt and updatedAt exactly", async () => {
    const adapter = new MemoryAdapter();
    const db = new Skalex({ adapter });
    await db.connect();
    db.createCollection("items", { changelog: true, versioning: true });
    const col = db.useCollection("items");

    const inserted = await col.insertOne({ _id: "x", label: "v1" });
    await tick();
    await col.updateOne({ _id: "x" }, { label: "v2" });
    const t2 = (await col.findOne({ _id: "x" })).updatedAt;
    await tick();
    await col.updateOne({ _id: "x" }, { label: "v3" });

    // Restore to "just after the first update" (before the v3 update).
    const between = new Date(t2.getTime() + 1);
    await db.restore("items", between, { _id: "x" });

    const after = await col.findOne({ _id: "x" });
    expect(after.label).toBe("v2");
    // Archived timestamps come back exactly - createdAt matches the insert,
    // updatedAt matches the first update. Pre-alpha.6 these were both reset
    // to `new Date()` at restore time.
    expect(after.createdAt.getTime()).toBe(inserted.createdAt.getTime());
    expect(after.updatedAt.getTime()).toBe(t2.getTime());
  });

  test("restoring a document preserves _version exactly", async () => {
    const adapter = new MemoryAdapter();
    const db = new Skalex({ adapter });
    await db.connect();
    db.createCollection("items", { changelog: true, versioning: true });
    const col = db.useCollection("items");

    await col.insertOne({ _id: "x", n: 0 });
    await tick();
    await col.updateOne({ _id: "x" }, { n: 1 });
    const afterFirstUpdate = new Date((await col.findOne({ _id: "x" })).updatedAt);
    await tick();
    await col.updateOne({ _id: "x" }, { n: 2 });
    await tick();
    await col.updateOne({ _id: "x" }, { n: 3 });

    // Current _version is 4 (1 insert + 3 updates).
    expect((await col.findOne({ _id: "x" }))._version).toBe(4);

    // Restore to the state after the first update - _version must be 2.
    await db.restore("items", new Date(afterFirstUpdate.getTime() + 1), { _id: "x" });
    const restored = await col.findOne({ _id: "x" });
    expect(restored._version).toBe(2);
    expect(restored.n).toBe(1);
  });

  test("restoring a document preserves _expiresAt from the archived state", async () => {
    const adapter = new MemoryAdapter();
    const db = new Skalex({ adapter });
    await db.connect();
    db.createCollection("items", { changelog: true, defaultTtl: "1d" });
    const col = db.useCollection("items");

    const first = await col.insertOne({ _id: "x", n: 1 });
    const archivedExpiry = first._expiresAt;
    await tick();
    await col.updateOne({ _id: "x" }, { n: 2 });
    await tick();
    await col.deleteOne({ _id: "x" });

    // Restore to the state after insert but before the update.
    await db.restore("items", first.updatedAt, { _id: "x" });
    const restored = await col.findOne({ _id: "x" });
    expect(restored).not.toBeNull();
    expect(restored._expiresAt.getTime()).toBe(archivedExpiry.getTime());
  });

  test("restoring a document preserves _vector exactly", async () => {
    const adapter = new MemoryAdapter();
    const db = new Skalex({ adapter });
    await db.connect();
    db.createCollection("items", { changelog: true });
    const col = db.useCollection("items");

    const archivedVector = [0.1, 0.2, 0.3];
    // Write directly through insertOne then inject the vector post-hoc so
    // we avoid needing a real embedding adapter. `insertOne` returns a
    // vector-stripped copy, so reach into the live _data array instead.
    await col.insertOne({ _id: "x", n: 1 });
    const stored = col._data.find(d => d._id === "x");
    stored._vector = archivedVector;
    await tick();
    // Update triggers a changelog entry whose `doc` snapshot includes the
    // _vector we just set.
    await col.updateOne({ _id: "x" }, { n: 2 });
    const afterUpdate = (await col.findOne({ _id: "x" })).updatedAt;
    await tick();
    await col.updateOne({ _id: "x" }, { n: 3 });

    await db.restore("items", new Date(afterUpdate.getTime() + 1), { _id: "x" });
    // findOne strips _vector by default. Reach into the store directly.
    const raw = col._data.find(d => d._id === "x");
    expect(raw._vector).toEqual(archivedVector);
  });

  test("full-collection restore preserves every document's system fields", async () => {
    const adapter = new MemoryAdapter();
    const db = new Skalex({ adapter });
    await db.connect();
    db.createCollection("items", { changelog: true, versioning: true });
    const col = db.useCollection("items");

    const a = await col.insertOne({ _id: "a", v: 1 });
    const b = await col.insertOne({ _id: "b", v: 1 });
    await tick();
    await col.updateOne({ _id: "a" }, { v: 2 });
    const snapshot = (await col.findOne({ _id: "a" })).updatedAt;
    await tick();
    // Further mutations that will be rolled back by restore.
    await col.updateOne({ _id: "a" }, { v: 99 });
    await col.deleteOne({ _id: "b" });
    await col.insertOne({ _id: "c", v: 50 });

    await db.restore("items", new Date(snapshot.getTime() + 1));

    const all = (await col.find({}, { sort: { _id: 1 } })).docs;
    expect(all.map(d => d._id)).toEqual(["a", "b"]);

    const aR = all.find(d => d._id === "a");
    expect(aR.v).toBe(2);
    expect(aR.createdAt.getTime()).toBe(a.createdAt.getTime());
    expect(aR.updatedAt.getTime()).toBe(snapshot.getTime());
    expect(aR._version).toBe(2);

    const bR = all.find(d => d._id === "b");
    expect(bR.v).toBe(1);
    expect(bR.createdAt.getTime()).toBe(b.createdAt.getTime());
    expect(bR.updatedAt.getTime()).toBe(b.updatedAt.getTime());
    expect(bR._version).toBe(1);
  });

  test("single-doc restore emits a DELETE event when archived state is 'not present'", async () => {
    const adapter = new MemoryAdapter();
    const db = new Skalex({ adapter });
    await db.connect();
    db.createCollection("items", { changelog: true });
    const col = db.useCollection("items");

    await col.insertOne({ _id: "x", n: 1 });
    await tick();
    await col.deleteOne({ _id: "x" });
    const deletedAt = new Date();
    await tick();
    await col.insertOne({ _id: "x", n: 99 });

    const events = [];
    const unsub = db.watch((ev) => { if (ev.collection === "items") events.push(ev.op); });
    await db.restore("items", deletedAt, { _id: "x" });
    unsub();
    expect(events).toEqual(["delete"]);
    await db.disconnect();
  });

  test("single-doc restore emits an UPDATE event when replacing an existing doc", async () => {
    const adapter = new MemoryAdapter();
    const db = new Skalex({ adapter });
    await db.connect();
    db.createCollection("items", { changelog: true });
    const col = db.useCollection("items");

    await col.insertOne({ _id: "x", v: 1 });
    await tick();
    await col.updateOne({ _id: "x" }, { v: 2 });
    const snap = (await col.findOne({ _id: "x" })).updatedAt;
    await tick();
    await col.updateOne({ _id: "x" }, { v: 99 });

    const events = [];
    const unsub = db.watch((ev) => { if (ev.collection === "items") events.push(ev.op); });
    await db.restore("items", new Date(snap.getTime() + 1), { _id: "x" });
    unsub();
    expect(events).toEqual(["update"]);
    await db.disconnect();
  });

  test("full-collection restore emits a delete-then-insert event per doc", async () => {
    const adapter = new MemoryAdapter();
    const db = new Skalex({ adapter });
    await db.connect();
    db.createCollection("items", { changelog: true });
    const col = db.useCollection("items");

    await col.insertOne({ _id: "a", v: 1 });
    await col.insertOne({ _id: "b", v: 1 });
    const snap = new Date();
    await tick();
    // Mutations after the snapshot timestamp that will be rolled back.
    await col.updateOne({ _id: "a" }, { v: 99 });
    await col.deleteOne({ _id: "b" });
    await col.insertOne({ _id: "c", v: 42 });

    const events = [];
    const unsub = db.watch((ev) => {
      if (ev.collection === "items") events.push({ op: ev.op, id: ev.doc._id });
    });
    await db.restore("items", snap);
    unsub();

    // Pre-restore docs (a, c): 2 delete events. Restored docs (a, b): 2 insert events.
    const deletes = events.filter(e => e.op === "delete").map(e => e.id).sort();
    const inserts = events.filter(e => e.op === "insert").map(e => e.id).sort();
    expect(deletes).toEqual(["a", "c"]);
    expect(inserts).toEqual(["a", "b"]);
    await db.disconnect();
  });

  test("restoring a DELETE entry removes the document without regenerating state", async () => {
    const adapter = new MemoryAdapter();
    const db = new Skalex({ adapter });
    await db.connect();
    db.createCollection("items", { changelog: true });
    const col = db.useCollection("items");

    await col.insertOne({ _id: "x", v: 1 });
    await tick();
    await col.deleteOne({ _id: "x" });
    const deletedAt = new Date();
    await tick();
    // Re-create the document with a new state.
    await col.insertOne({ _id: "x", v: 99 });

    // Restore to "just after delete, before re-insert".
    await db.restore("items", deletedAt, { _id: "x" });
    expect(await col.findOne({ _id: "x" })).toBeNull();
  });
});
