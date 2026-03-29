/**
 * Unit tests for changelog.js — ChangeLog class.
 */
import { describe, test, expect, beforeEach } from "vitest";
import Skalex from "../../src/index.js";
import MemoryAdapter from "../helpers/MemoryAdapter.js";

function makeDb() {
  const adapter = new MemoryAdapter();
  return new Skalex({ adapter });
}

// ─── log / query ─────────────────────────────────────────────────────────────

describe("ChangeLog — log / query", () => {
  test("log() records an insert entry", async () => {
    const db = makeDb();
    const cl = db.changelog();
    const doc = { _id: "1", name: "Alice", createdAt: new Date(), updatedAt: new Date() };
    await cl.log("insert", "users", doc);
    const entries = await cl.query("users");
    expect(entries).toHaveLength(1);
    expect(entries[0].op).toBe("insert");
    expect(entries[0].docId).toBe("1");
    expect(entries[0].collection).toBe("users");
  });

  test("log() records an update entry with prev", async () => {
    const db = makeDb();
    const cl = db.changelog();
    const prev = { _id: "1", name: "Alice", createdAt: new Date(), updatedAt: new Date() };
    const doc  = { _id: "1", name: "Alicia", createdAt: new Date(), updatedAt: new Date() };
    await cl.log("update", "users", doc, prev);
    const entries = await cl.query("users");
    expect(entries[0].op).toBe("update");
    expect(entries[0].prev).toBeDefined();
    expect(entries[0].prev.name).toBe("Alice");
    expect(entries[0].doc.name).toBe("Alicia");
  });

  test("log() records a delete entry", async () => {
    const db = makeDb();
    const cl = db.changelog();
    const doc = { _id: "2", name: "Bob", createdAt: new Date(), updatedAt: new Date() };
    await cl.log("delete", "users", doc);
    const entries = await cl.query("users");
    expect(entries[0].op).toBe("delete");
  });

  test("query() filters by collection", async () => {
    const db = makeDb();
    const cl = db.changelog();
    const d1 = { _id: "1", createdAt: new Date(), updatedAt: new Date() };
    const d2 = { _id: "2", createdAt: new Date(), updatedAt: new Date() };
    await cl.log("insert", "users", d1);
    await cl.log("insert", "orders", d2);
    expect(await cl.query("users")).toHaveLength(1);
    expect(await cl.query("orders")).toHaveLength(1);
  });

  test("query() filters by session", async () => {
    const db = makeDb();
    const cl = db.changelog();
    const d = { _id: "1", createdAt: new Date(), updatedAt: new Date() };
    await cl.log("insert", "users", d, null, "sess-A");
    await cl.log("insert", "users", d, null, "sess-B");
    const entries = await cl.query("users", { session: "sess-A" });
    expect(entries).toHaveLength(1);
    expect(entries[0].session).toBe("sess-A");
  });

  test("query() respects limit", async () => {
    const db = makeDb();
    const cl = db.changelog();
    for (let i = 0; i < 5; i++) {
      await cl.log("insert", "items", { _id: String(i), createdAt: new Date(), updatedAt: new Date() });
    }
    const entries = await cl.query("items", { limit: 3 });
    expect(entries).toHaveLength(3);
  });

  test("query() returns entries sorted oldest-first", async () => {
    const db = makeDb();
    const cl = db.changelog();
    await cl.log("insert", "t", { _id: "a", createdAt: new Date(), updatedAt: new Date() });
    await cl.log("insert", "t", { _id: "b", createdAt: new Date(), updatedAt: new Date() });
    const entries = await cl.query("t");
    expect(new Date(entries[0].timestamp) <= new Date(entries[1].timestamp)).toBe(true);
  });

  test("log() stores timestamp on each entry", async () => {
    const db = makeDb();
    const cl = db.changelog();
    const before = new Date();
    await cl.log("insert", "t", { _id: "x", createdAt: new Date(), updatedAt: new Date() });
    const after = new Date();
    const entries = await cl.query("t");
    const ts = new Date(entries[0].timestamp);
    expect(ts >= before).toBe(true);
    expect(ts <= after).toBe(true);
  });
});

// ─── Collection changelog option ─────────────────────────────────────────────

describe("Collection changelog: true option", () => {
  test("insertOne logs an entry when changelog:true", async () => {
    const db = makeDb();
    await db.connect();
    db.createCollection("events", { changelog: true });
    const events = db.useCollection("events");
    await events.insertOne({ type: "login" });
    const entries = await db.changelog().query("events");
    expect(entries).toHaveLength(1);
    expect(entries[0].op).toBe("insert");
    await db.disconnect();
  });

  test("insertMany logs one entry per doc", async () => {
    const db = makeDb();
    await db.connect();
    db.createCollection("events", { changelog: true });
    const events = db.useCollection("events");
    await events.insertMany([{ type: "a" }, { type: "b" }]);
    const entries = await db.changelog().query("events");
    expect(entries).toHaveLength(2);
    await db.disconnect();
  });

  test("updateOne logs an update entry with prev", async () => {
    const db = makeDb();
    await db.connect();
    db.createCollection("items", { changelog: true });
    const items = db.useCollection("items");
    const { data } = await items.insertOne({ name: "old" });
    await items.updateOne({ _id: data._id }, { name: "new" });
    const entries = await db.changelog().query("items");
    const updateEntry = entries.find(e => e.op === "update");
    expect(updateEntry).toBeDefined();
    expect(updateEntry.prev.name).toBe("old");
    expect(updateEntry.doc.name).toBe("new");
    await db.disconnect();
  });

  test("deleteOne logs a delete entry", async () => {
    const db = makeDb();
    await db.connect();
    db.createCollection("items", { changelog: true });
    const items = db.useCollection("items");
    const { data } = await items.insertOne({ name: "to-delete" });
    await items.deleteOne({ _id: data._id });
    const entries = await db.changelog().query("items");
    const del = entries.find(e => e.op === "delete");
    expect(del).toBeDefined();
    expect(del.docId).toBe(data._id);
    await db.disconnect();
  });

  test("changelog is NOT logged when changelog:false (default)", async () => {
    const db = makeDb();
    await db.connect();
    const users = db.useCollection("users");
    await users.insertOne({ name: "Alice" });
    const entries = await db.changelog().query("users");
    expect(entries).toHaveLength(0);
    await db.disconnect();
  });
});

// ─── restore ─────────────────────────────────────────────────────────────────

describe("ChangeLog — restore", () => {
  // Helper: backdate the last N changelog entries in _data to a given Date.
  function backdateLastEntries(db, n, ts) {
    const data = db.useCollection("_changelog")._data;
    for (let i = data.length - n; i < data.length; i++) {
      data[i].timestamp = ts;
    }
  }

  test("restore() rebuilds entire collection from log", async () => {
    const db = makeDb();
    await db.connect();
    const cl = db.changelog();
    const col = db.useCollection("notes");

    const T_PAST   = new Date("2020-01-01");
    const T_SNAP   = new Date("2020-06-01");
    const T_FUTURE = new Date("2020-12-01");

    // Simulate two inserts that happened before the snapshot
    const n1 = { _id: "n1", text: "note A", createdAt: T_PAST, updatedAt: T_PAST };
    const n2 = { _id: "n2", text: "note B", createdAt: T_PAST, updatedAt: T_PAST };
    await cl.log("insert", "notes", n1);
    await cl.log("insert", "notes", n2);
    backdateLastEntries(db, 2, T_PAST);

    // Simulate a delete + update that happened after the snapshot
    await cl.log("delete", "notes", n1);
    await cl.log("update", "notes", { ...n2, text: "note B edited" });
    backdateLastEntries(db, 2, T_FUTURE);

    // Restore to T_SNAP — only the two inserts are replayed
    await db.restore("notes", T_SNAP);

    const { docs } = await col.find({});
    expect(docs.find(d => d._id === "n1")).toBeDefined();
    expect(docs.find(d => d.text === "note B")).toBeDefined();
    expect(docs.find(d => d.text === "note B edited")).toBeUndefined();

    await db.disconnect();
  });

  test("restore() can restore a single document by _id", async () => {
    const db = makeDb();
    await db.connect();
    const cl = db.changelog();
    const col = db.useCollection("docs");

    const T_PAST   = new Date("2020-01-01");
    const T_SNAP   = new Date("2020-06-01");
    const T_FUTURE = new Date("2020-12-01");

    const doc = { _id: "d1", value: "original", createdAt: T_PAST, updatedAt: T_PAST };
    await cl.log("insert", "docs", doc);
    backdateLastEntries(db, 1, T_PAST);

    await cl.log("update", "docs", { ...doc, value: "modified", updatedAt: T_FUTURE });
    backdateLastEntries(db, 1, T_FUTURE);

    // Put the modified version in the live collection
    await col.insertOne({ _id: "d1", value: "modified" });

    await db.restore("docs", T_SNAP, { _id: "d1" });

    const found = await col.findOne({ _id: "d1" });
    expect(found.value).toBe("original");

    await db.disconnect();
  });

  test("restore() does nothing for empty log", async () => {
    const db = makeDb();
    await db.connect();
    // No entries logged — restore should not throw
    await expect(db.restore("empty", new Date())).resolves.toBeUndefined();
    await db.disconnect();
  });
});
