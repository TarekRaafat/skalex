/**
 * Unit tests for aggregation.js + Collection aggregation methods.
 */
import { describe, test, expect } from "vitest";
import { count, sum, avg, groupBy } from "../../src/features/aggregation.js";
import Skalex from "../../src/index.js";
import MemoryAdapter from "../helpers/MemoryAdapter.js";

// ─── Pure aggregation functions ───────────────────────────────────────────────

const DOCS = [
  { name: "Alice", age: 30, dept: "eng" },
  { name: "Bob",   age: 25, dept: "eng" },
  { name: "Carol", age: 35, dept: "hr"  },
  { name: "Dave",  age: 28, dept: "hr"  },
];

describe("count()", () => {
  test("returns the number of docs", () => {
    expect(count(DOCS)).toBe(4);
  });

  test("returns 0 for empty array", () => {
    expect(count([])).toBe(0);
  });
});

describe("sum()", () => {
  test("sums a numeric field", () => {
    expect(sum(DOCS, "age")).toBe(118);
  });

  test("returns 0 for empty array", () => {
    expect(sum([], "age")).toBe(0);
  });

  test("skips non-numeric values", () => {
    const docs = [{ v: 1 }, { v: "text" }, { v: null }, { v: 3 }];
    expect(sum(docs, "v")).toBe(4);
  });

  test("supports dot-notation field", () => {
    const docs = [
      { meta: { score: 10 } },
      { meta: { score: 20 } },
    ];
    expect(sum(docs, "meta.score")).toBe(30);
  });
});

describe("avg()", () => {
  test("averages a numeric field", () => {
    expect(avg(DOCS, "age")).toBeCloseTo(29.5);
  });

  test("returns null for empty array", () => {
    expect(avg([], "age")).toBeNull();
  });

  test("returns null when no numeric values exist", () => {
    expect(avg([{ v: "text" }], "v")).toBeNull();
  });
});

describe("groupBy()", () => {
  test("groups docs by field value", () => {
    const groups = groupBy(DOCS, "dept");
    expect(Object.keys(groups)).toHaveLength(2);
    expect(groups.eng).toHaveLength(2);
    expect(groups.hr).toHaveLength(2);
  });

  test("groups null/undefined values under __null__", () => {
    const docs = [{ v: null }, { v: undefined }, { v: "a" }];
    const groups = groupBy(docs, "v");
    expect(groups.__null__).toHaveLength(2);
    expect(groups.a).toHaveLength(1);
  });

  test("returns empty object for empty array", () => {
    expect(groupBy([], "dept")).toEqual({});
  });

  test("supports dot-notation field", () => {
    const docs = [
      { meta: { type: "x" } },
      { meta: { type: "x" } },
      { meta: { type: "y" } },
    ];
    const groups = groupBy(docs, "meta.type");
    expect(groups.x).toHaveLength(2);
    expect(groups.y).toHaveLength(1);
  });
});

// ─── Collection aggregation methods ──────────────────────────────────────────

function makeDb() {
  return new Skalex({ adapter: new MemoryAdapter() });
}

describe("collection.count()", () => {
  test("counts all docs when no filter", async () => {
    const db  = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    await col.insertMany([{ v: 1 }, { v: 2 }, { v: 3 }]);
    expect(await col.count()).toBe(3);
    await db.disconnect();
  });

  test("counts docs matching filter", async () => {
    const db  = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    await col.insertMany([{ active: true }, { active: false }, { active: true }]);
    expect(await col.count({ active: true })).toBe(2);
    await db.disconnect();
  });

  test("returns 0 for empty collection", async () => {
    const db  = makeDb();
    await db.connect();
    expect(await db.useCollection("empty").count()).toBe(0);
    await db.disconnect();
  });
});

describe("collection.sum()", () => {
  test("sums a field across all docs", async () => {
    const db  = makeDb();
    await db.connect();
    const col = db.useCollection("orders");
    await col.insertMany([{ amount: 10 }, { amount: 20 }, { amount: 30 }]);
    expect(await col.sum("amount")).toBe(60);
    await db.disconnect();
  });

  test("sums only filtered docs", async () => {
    const db  = makeDb();
    await db.connect();
    const col = db.useCollection("orders");
    await col.insertMany([
      { amount: 10, status: "paid"    },
      { amount: 20, status: "pending" },
      { amount: 30, status: "paid"    },
    ]);
    expect(await col.sum("amount", { status: "paid" })).toBe(40);
    await db.disconnect();
  });
});

describe("collection.avg()", () => {
  test("averages a numeric field", async () => {
    const db  = makeDb();
    await db.connect();
    const col = db.useCollection("scores");
    await col.insertMany([{ score: 80 }, { score: 90 }, { score: 100 }]);
    expect(await col.avg("score")).toBeCloseTo(90);
    await db.disconnect();
  });

  test("returns null for empty collection", async () => {
    const db  = makeDb();
    await db.connect();
    expect(await db.useCollection("empty").avg("score")).toBeNull();
    await db.disconnect();
  });
});

describe("collection.groupBy()", () => {
  test("groups docs by field value", async () => {
    const db  = makeDb();
    await db.connect();
    const col = db.useCollection("users");
    await col.insertMany([
      { name: "Alice", role: "admin" },
      { name: "Bob",   role: "user"  },
      { name: "Carol", role: "admin" },
    ]);
    const groups = await col.groupBy("role");
    expect(groups.admin).toHaveLength(2);
    expect(groups.user).toHaveLength(1);
    await db.disconnect();
  });
});

// ─── db.stats() ───────────────────────────────────────────────────────────────

describe("db.stats()", () => {
  test("returns stats for a single collection", async () => {
    const db  = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    await col.insertMany([{ v: 1 }, { v: 2 }]);
    const s = db.stats("items");
    expect(s.collection).toBe("items");
    expect(s.count).toBe(2);
    expect(s.estimatedSize).toBeGreaterThan(0);
    expect(s.avgDocSize).toBeGreaterThan(0);
    await db.disconnect();
  });

  test("returns null for unknown collection", () => {
    const db = makeDb();
    expect(db.stats("nonexistent")).toBeNull();
  });

  test("returns array of stats when no collection specified", async () => {
    const db  = makeDb();
    await db.connect();
    db.useCollection("a");
    db.useCollection("b");
    const all = db.stats();
    expect(Array.isArray(all)).toBe(true);
    await db.disconnect();
  });

  test("avgDocSize is 0 for empty collection", async () => {
    const db  = makeDb();
    await db.connect();
    db.useCollection("empty");
    const s = db.stats("empty");
    expect(s.count).toBe(0);
    expect(s.avgDocSize).toBe(0);
    await db.disconnect();
  });
});

// ─── db.slowQueries() ────────────────────────────────────────────────────────

describe("db.slowQueries()", () => {
  test("returns empty array when no slow query log configured", () => {
    const db = makeDb();
    expect(db.slowQueries()).toEqual([]);
  });

  test("records queries over the threshold", async () => {
    const db  = new Skalex({ adapter: new MemoryAdapter(), slowQueryLog: { threshold: 0 } });
    await db.connect();
    const col = db.useCollection("items");
    await col.insertMany([{ v: 1 }, { v: 2 }]);
    await col.find({});
    const entries = db.slowQueries();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0].collection).toBe("items");
    expect(entries[0].op).toBe("find");
    await db.disconnect();
  });

  test("respects limit option", async () => {
    const db  = new Skalex({ adapter: new MemoryAdapter(), slowQueryLog: { threshold: 0 } });
    await db.connect();
    const col = db.useCollection("items");
    for (let i = 0; i < 5; i++) await col.find({});
    const entries = db.slowQueries({ limit: 3 });
    expect(entries).toHaveLength(3);
    await db.disconnect();
  });

  test("session tagging on insertOne is passed to changelog", async () => {
    const db  = makeDb();
    await db.connect();
    db.createCollection("events", { changelog: true });
    const col = db.useCollection("events");
    await col.insertOne({ type: "login" }, { session: "user-123" });
    const entries = await db.changelog().query("events");
    expect(entries[0].session).toBe("user-123");
    await db.disconnect();
  });
});
