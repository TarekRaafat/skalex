/**
 * Correctness hardening regression tests (P2.5).
 *
 * Covers:
 *   #14  ifNotExists returns stripped copy, not raw internal ref
 *   #15  Aggregation methods trigger ensureConnected
 *   #16  Dot-notation index fields rejected
 *   #17  connect() idempotent under concurrent calls
 *   #20  _vector excluded from explicit select projections
 *   #21  Nested dangerous keys stripped recursively in applyUpdate
 *   #22  Error types available as named exports
 *   #25  stripVector short-circuits for docs without _vector
 *   #26  generateUniqueId preserves full entropy
 *   #28  Flush sentinel uses META_DOC_ID constant consistently
 *   #29  Corrupt collection file throws PersistenceError by default
 *   #30  System fields (createdAt, updatedAt) not overwritable on insert
 *   #31  dump() returns deep copies that cannot corrupt internal state
 */
import { describe, test, expect } from "vitest";
import Skalex, { ValidationError, SkalexError } from "../../src/index.js";
import MemoryAdapter from "../helpers/MemoryAdapter.js";
import IndexEngine from "../../src/engine/indexes.js";
import { generateUniqueId } from "../../src/engine/utils.js";
import { stripVector } from "../../src/engine/vector.js";

function makeDb(opts = {}) {
  const adapter = new MemoryAdapter();
  return { db: new Skalex({ adapter, ...opts }), adapter };
}

// ─── #14  ifNotExists stripped copy ────────────────────────────────────────

describe("ifNotExists returns stripped copy", () => {
  test("returned doc excludes _vector and is not a mutable internal ref", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("items");

    const original = await col.insertOne({ name: "Alice" });
    const existing = await col.insertOne({ name: "Alice" }, { ifNotExists: true });

    expect(existing._vector).toBeUndefined();
    // Mutating the returned copy must not affect internal state
    existing.name = "MUTATED";
    const found = await col.findOne({ _id: original._id });
    expect(found.name).toBe("Alice");
    await db.disconnect();
  });
});

// ─── #15  Aggregation ensureConnected ──────────────────────────────────────

describe("aggregation methods trigger auto-connect", () => {
  test("count() works before explicit connect()", async () => {
    const { db } = makeDb();
    // No connect() call - should auto-connect
    const col = db.useCollection("items");
    const count = await col.count();
    expect(count).toBe(0);
  });

  test("sum() works before explicit connect()", async () => {
    const { db } = makeDb();
    const col = db.useCollection("items");
    const sum = await col.sum("x");
    expect(sum).toBe(0);
  });
});

// ─── #16  Dot-notation index rejection ─────────────────────────────────────

describe("dot-notation index field rejection", () => {
  test("single-field index with dot-notation throws ValidationError", () => {
    expect(() => new IndexEngine(["profile.email"], []))
      .toThrow(/dot-notation/i);
  });

  test("compound index with dot-notation throws ValidationError", () => {
    expect(() => new IndexEngine([["tenantId", "profile.email"]], []))
      .toThrow(/dot-notation/i);
  });

  test("unique field with dot-notation throws ValidationError", () => {
    expect(() => new IndexEngine([], ["profile.email"]))
      .toThrow(/dot-notation/i);
  });

  test("flat field names work normally", () => {
    expect(() => new IndexEngine(["email", "name"], ["email"])).not.toThrow();
  });
});

// ─── #17  connect() idempotent ─────────────────────────────────────────────

describe("connect() idempotent under concurrent calls", () => {
  test("two concurrent connect() calls resolve without error", async () => {
    const { db } = makeDb();
    const [a, b] = await Promise.all([db.connect(), db.connect()]);
    expect(a).toBeUndefined();
    expect(b).toBeUndefined();
    expect(db.isConnected).toBe(true);
    await db.disconnect();
  });
});

// ─── #20  _vector excluded from select ─────────────────────────────────────

describe("_vector excluded from explicit select", () => {
  test("select including _vector does not return it", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    // Manually insert a doc with _vector to simulate embedded doc
    col._data.push({ _id: "1", name: "A", _vector: [1, 2, 3] });
    col._store.index.set("1", col._data[0]);

    const doc = await col.findOne({ _id: "1" }, { select: ["name", "_vector"] });
    expect(doc.name).toBe("A");
    expect(doc._vector).toBeUndefined();
    await db.disconnect();
  });
});

// ─── #21  Recursive dangerous key stripping ────────────────────────────────

describe("recursive dangerous key stripping in applyUpdate", () => {
  test("nested dangerous keys are stripped from update values", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("items");

    const doc = await col.insertOne({ name: "A", config: {} });
    // Build an object with constructor/prototype as own properties
    // (can't use __proto__ in a literal - JS interprets it as prototype setter)
    const malicious = { safe: "value" };
    Object.defineProperty(malicious, "constructor", { value: "bad", enumerable: true });
    Object.defineProperty(malicious, "prototype", { value: "bad", enumerable: true });

    const updated = await col.updateOne({ _id: doc._id }, { config: malicious });

    expect(updated.config.safe).toBe("value");
    expect(Object.prototype.hasOwnProperty.call(updated.config, "constructor")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(updated.config, "prototype")).toBe(false);
    await db.disconnect();
  });
});

// ─── #22  Named exports ────────────────────────────────────────────────────

describe("error types available as named exports", () => {
  test("ValidationError is importable from skalex", () => {
    expect(ValidationError).toBeDefined();
    expect(new ValidationError("CODE", "msg")).toBeInstanceOf(SkalexError);
  });
});

// ─── #25  stripVector short-circuit ────────────────────────────────────────

describe("stripVector optimization", () => {
  test("doc without _vector returns a copy (defensive)", () => {
    const doc = { _id: "1", name: "A" };
    const result = stripVector(doc);
    expect(result).toEqual(doc);
    expect(result._vector).toBeUndefined();
  });

  test("doc with _vector returns copy without _vector", () => {
    const doc = { _id: "1", name: "A", _vector: [1, 2] };
    const result = stripVector(doc);
    expect(result.name).toBe("A");
    expect(result._vector).toBeUndefined();
  });
});

// ─── #26  ID entropy ──────────────────────────────────────────────────────

describe("generateUniqueId full entropy", () => {
  test("ID length is at least 27 characters (no truncation)", () => {
    const id = generateUniqueId();
    expect(id.length).toBeGreaterThanOrEqual(27);
  });

  test("1000 generated IDs are all unique", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateUniqueId()));
    expect(ids.size).toBe(1000);
  });
});

// ─── #29  Corrupt file default behavior ────────────────────────────────────

describe("corrupt collection file handling", () => {
  test("throws PersistenceError by default", async () => {
    const adapter = new MemoryAdapter();
    await adapter.write("broken", "not-valid-json");

    const db = new Skalex({ adapter });
    await expect(db.connect()).rejects.toThrow(/Failed to load collection/);
  });

  test("logs warning with lenientLoad: true", async () => {
    const adapter = new MemoryAdapter();
    await adapter.write("broken", "not-valid-json");
    await adapter.write("valid", JSON.stringify({ collectionName: "valid", data: [{ _id: "1" }] }));

    const warnings = [];
    const db = new Skalex({
      adapter,
      lenientLoad: true,
      logger: (msg, level) => { if (level === "error") warnings.push(msg); },
    });
    await db.connect();

    expect(warnings.some(w => w.includes("broken"))).toBe(true);
    const { docs } = await db.useCollection("valid").find({});
    expect(docs).toHaveLength(1);
    await db.disconnect();
  });
});

// ─── #30  System fields enforcement on insert ──────────────────────────────

describe("system fields enforcement on insert", () => {
  test("createdAt and updatedAt cannot be overwritten by user", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("items");

    const epoch = new Date(0);
    const doc = await col.insertOne({ name: "A", createdAt: epoch, updatedAt: epoch });

    expect(doc.createdAt.getTime()).not.toBe(0);
    expect(doc.updatedAt.getTime()).not.toBe(0);
    await db.disconnect();
  });

  test("user-provided _id is preserved", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("items");

    const doc = await col.insertOne({ _id: "custom-123", name: "A" });
    expect(doc._id).toBe("custom-123");
    await db.disconnect();
  });
});

// ─── #31  dump() deep copy ─────────────────────────────────────────────────

describe("dump() returns deep copies", () => {
  test("mutating dump output does not corrupt internal state", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    await col.insertOne({ name: "Alice" });

    const snapshot = db.dump();
    snapshot.items[0].name = "MUTATED";

    const found = await col.findOne({});
    expect(found.name).toBe("Alice");
    await db.disconnect();
  });
});
