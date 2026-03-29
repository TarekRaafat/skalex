/**
 * Unit tests for SessionStats + db.sessionStats() integration.
 */
import { describe, test, expect, beforeEach } from "vitest";
import SessionStats from "../../src/session-stats.js";
import Skalex from "../../src/index.js";
import MemoryAdapter from "../helpers/MemoryAdapter.js";

// ─── Pure SessionStats ────────────────────────────────────────────────────────

describe("SessionStats — basic tracking", () => {
  let stats;
  beforeEach(() => { stats = new SessionStats(); });

  test("get() returns null for unknown session", () => {
    expect(stats.get("x")).toBeNull();
  });

  test("recordRead() increments reads and sets lastActive", () => {
    stats.recordRead("s1");
    const s = stats.get("s1");
    expect(s.reads).toBe(1);
    expect(s.writes).toBe(0);
    expect(s.lastActive).toBeInstanceOf(Date);
  });

  test("recordWrite() increments writes and sets lastActive", () => {
    stats.recordWrite("s1");
    const s = stats.get("s1");
    expect(s.reads).toBe(0);
    expect(s.writes).toBe(1);
    expect(s.lastActive).toBeInstanceOf(Date);
  });

  test("multiple calls accumulate correctly", () => {
    stats.recordRead("s1");
    stats.recordRead("s1");
    stats.recordWrite("s1");
    const s = stats.get("s1");
    expect(s.reads).toBe(2);
    expect(s.writes).toBe(1);
  });

  test("different sessions are tracked independently", () => {
    stats.recordRead("alice");
    stats.recordWrite("bob");
    expect(stats.get("alice").reads).toBe(1);
    expect(stats.get("alice").writes).toBe(0);
    expect(stats.get("bob").reads).toBe(0);
    expect(stats.get("bob").writes).toBe(1);
  });

  test("recordRead() is a no-op for falsy sessionId", () => {
    stats.recordRead(null);
    stats.recordRead(undefined);
    stats.recordRead("");
    expect(stats.all()).toHaveLength(0);
  });

  test("recordWrite() is a no-op for falsy sessionId", () => {
    stats.recordWrite(null);
    expect(stats.all()).toHaveLength(0);
  });

  test("get() returns an object with sessionId included", () => {
    stats.recordRead("mySession");
    const s = stats.get("mySession");
    expect(s.sessionId).toBe("mySession");
  });

  test("all() returns all tracked sessions", () => {
    stats.recordRead("a");
    stats.recordWrite("b");
    const all = stats.all();
    expect(all).toHaveLength(2);
    expect(all.map(s => s.sessionId)).toContain("a");
    expect(all.map(s => s.sessionId)).toContain("b");
  });

  test("all() returns empty array when nothing tracked", () => {
    expect(stats.all()).toEqual([]);
  });
});

describe("SessionStats — clear()", () => {
  let stats;
  beforeEach(() => {
    stats = new SessionStats();
    stats.recordRead("a");
    stats.recordRead("b");
  });

  test("clear(sessionId) removes one session", () => {
    stats.clear("a");
    expect(stats.get("a")).toBeNull();
    expect(stats.get("b")).not.toBeNull();
  });

  test("clear() with no arg removes all sessions", () => {
    stats.clear();
    expect(stats.all()).toHaveLength(0);
  });
});

// ─── db.sessionStats() integration ───────────────────────────────────────────

function makeDb() {
  return new Skalex({ adapter: new MemoryAdapter() });
}

describe("db.sessionStats()", () => {
  test("returns null for unknown session", () => {
    const db = makeDb();
    expect(db.sessionStats("unknown")).toBeNull();
  });

  test("returns empty array when no session arg given and nothing tracked", () => {
    const db = makeDb();
    expect(db.sessionStats()).toEqual([]);
  });

  test("write operations with session record writes", async () => {
    const db = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    await col.insertOne({ v: 1 }, { session: "user-1" });
    const s = db.sessionStats("user-1");
    expect(s.writes).toBe(1);
    await db.disconnect();
  });

  test("read operations with session record reads", async () => {
    const db = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    await col.insertMany([{ v: 1 }, { v: 2 }]);
    await col.find({}, { session: "user-2" });
    const s = db.sessionStats("user-2");
    expect(s.reads).toBe(1);
    await db.disconnect();
  });

  test("session is tracked across insert and find", async () => {
    const db = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    await col.insertOne({ v: 1 }, { session: "user-3" });
    await col.insertOne({ v: 2 }, { session: "user-3" });
    await col.find({}, { session: "user-3" });
    const s = db.sessionStats("user-3");
    expect(s.writes).toBe(2);
    expect(s.reads).toBe(1);
    await db.disconnect();
  });

  test("db.sessionStats() with no arg returns all sessions", async () => {
    const db = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    await col.insertOne({ v: 1 }, { session: "alice" });
    await col.find({}, { session: "bob" });
    const all = db.sessionStats();
    const ids = all.map(s => s.sessionId);
    expect(ids).toContain("alice");
    expect(ids).toContain("bob");
    await db.disconnect();
  });

  test("updateOne records a write", async () => {
    const db = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    await col.insertOne({ name: "x" });
    await col.updateOne({ name: "x" }, { name: "y" }, { session: "user-4" });
    expect(db.sessionStats("user-4").writes).toBe(1);
    await db.disconnect();
  });

  test("deleteOne records a write", async () => {
    const db = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    const { data } = await col.insertOne({ name: "x" });
    await col.deleteOne({ _id: data._id }, { session: "user-5" });
    expect(db.sessionStats("user-5").writes).toBe(1);
    await db.disconnect();
  });

  test("lastActive is set after a tracked operation", async () => {
    const db = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    await col.insertOne({ v: 1 }, { session: "s1" });
    expect(db.sessionStats("s1").lastActive).toBeInstanceOf(Date);
    await db.disconnect();
  });
});
