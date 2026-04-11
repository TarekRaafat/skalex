/**
 * Integration tests for Skalex + Collection.
 *
 * All I/O is routed through MemoryAdapter  -  no file system access in CI.
 */
import { describe, test, expect } from "vitest";
import Skalex from "../../src/index.js";
import MemoryAdapter from "../helpers/MemoryAdapter.js";
import MockEmbeddingAdapter from "../helpers/MockEmbeddingAdapter.js";
import MockLLMAdapter from "../helpers/MockLLMAdapter.js";

function makeDb(opts = {}) {
  const adapter = new MemoryAdapter();
  const db = new Skalex({ adapter, ...opts });
  return { db, adapter };
}

// ─── connect / disconnect ────────────────────────────────────────────────────

describe("connect / disconnect", () => {
  test("connect() sets isConnected = true", async () => {
    const { db } = makeDb();
    await db.connect();
    expect(db.isConnected).toBe(true);
    await db.disconnect();
  });

  test("disconnect() sets isConnected = false and clears instances", async () => {
    const { db } = makeDb();
    await db.connect();
    db.useCollection("users");
    await db.disconnect();
    expect(db.isConnected).toBe(false);
    expect(Object.keys(db._collectionInstances)).toHaveLength(0);
  });

  test("Collection methods auto-connect if connect() was never called", async () => {
    const { db } = makeDb();
    // Deliberately skip db.connect()
    const users = db.useCollection("users");
    const doc = await users.insertOne({ name: "Alice" });
    expect(doc._id).toBeDefined();
    expect(db.isConnected).toBe(true);
  });
});

// ─── CRUD ────────────────────────────────────────────────────────────────────

describe("insertOne / findOne", () => {
  test("inserts document with auto _id, createdAt, updatedAt", async () => {
    const { db } = makeDb();
    await db.connect();
    const users = db.useCollection("users");
    const data = await users.insertOne({ name: "Alice", age: 30 });

    expect(data._id).toBeDefined();
    expect(data.name).toBe("Alice");
    expect(data.createdAt).toBeInstanceOf(Date);
    expect(data.updatedAt).toBeInstanceOf(Date);
    await db.disconnect();
  });

  test("findOne returns projected document (select)", async () => {
    const { db } = makeDb();
    await db.connect();
    const users = db.useCollection("users");
    await users.insertOne({ name: "Alice", age: 30, role: "admin" });
    const doc = await users.findOne({ name: "Alice" }, { select: ["name"] });
    expect(Object.keys(doc)).toHaveLength(1);
    expect(doc.name).toBe("Alice");
    expect(doc.age).toBeUndefined();
    await db.disconnect();
  });

  test("find returns projected documents (select)", async () => {
    const { db } = makeDb();
    await db.connect();
    const users = db.useCollection("users");
    await users.insertMany([
      { name: "Alice", age: 30 },
      { name: "Bob", age: 25 },
    ]);
    const { docs } = await users.find({}, { select: ["name"] });
    expect(docs).toHaveLength(2);
    expect(docs.every(d => d.name !== undefined)).toBe(true);
    expect(docs.every(d => d.age === undefined)).toBe(true);
    await db.disconnect();
  });

  test("findOne _id fast path", async () => {
    const { db } = makeDb();
    await db.connect();
    const users = db.useCollection("users");
    const inserted = await users.insertOne({ name: "Alice" });
    const doc = await users.findOne({ _id: inserted._id });
    expect(doc._id).toBe(inserted._id);
    await db.disconnect();
  });

  test("findOne returns null for no match", async () => {
    const { db } = makeDb();
    await db.connect();
    const users = db.useCollection("users");
    await users.insertOne({ name: "Alice" });
    expect(await users.findOne({ name: "Bob" })).toBeNull();
    await db.disconnect();
  });
});

describe("insertMany", () => {
  test("inserts multiple documents", async () => {
    const { db } = makeDb();
    await db.connect();
    const users = db.useCollection("users");
    const docs = await users.insertMany([{ name: "Alice" }, { name: "Bob" }]);
    expect(docs).toHaveLength(2);
    expect(docs[0]._id).toBeDefined();
    await db.disconnect();
  });
});

describe("find", () => {
  test("returns all docs matching filter", async () => {
    const { db } = makeDb();
    await db.connect();
    const users = db.useCollection("users");
    await users.insertMany([
      { name: "Alice", role: "admin", age: 30 },
      { name: "Bob",   role: "admin", age: 25 },
      { name: "Carol", role: "user",  age: 30 },
    ]);

    const r = await users.find({ role: "admin", age: 30 });
    expect(r.docs).toHaveLength(1);
    expect(r.docs[0].name).toBe("Alice");
    await db.disconnect();
  });

  test("$in operator", async () => {
    const { db } = makeDb();
    await db.connect();
    const users = db.useCollection("users");
    await users.insertMany([
      { name: "Alice", role: "admin" },
      { name: "Bob",   role: "user" },
      { name: "Carol", role: "guest" },
    ]);
    const r = await users.find({ role: { $in: ["admin", "user"] } });
    expect(r.docs).toHaveLength(2);
    await db.disconnect();
  });

  test("$nin operator", async () => {
    const { db } = makeDb();
    await db.connect();
    const users = db.useCollection("users");
    await users.insertMany([
      { name: "Alice", role: "admin" },
      { name: "Bob",   role: "user" },
      { name: "Carol", role: "guest" },
    ]);
    const r = await users.find({ role: { $nin: ["admin", "guest"] } });
    expect(r.docs).toHaveLength(1);
    expect(r.docs[0].name).toBe("Bob");
    await db.disconnect();
  });

  test("RegExp filter", async () => {
    const { db } = makeDb();
    await db.connect();
    const users = db.useCollection("users");
    await users.insertMany([{ name: "Alice" }, { name: "Bob" }]);
    const r = await users.find({ name: /^Al/ });
    expect(r.docs).toHaveLength(1);
    await db.disconnect();
  });

  test("dot-notation nested filter", async () => {
    const { db } = makeDb();
    await db.connect();
    const users = db.useCollection("users");
    await users.insertMany([
      { name: "Alice", address: { city: "Cairo" } },
      { name: "Bob",   address: { city: "London" } },
    ]);
    const r = await users.find({ "address.city": "Cairo" });
    expect(r.docs).toHaveLength(1);
    expect(r.docs[0].name).toBe("Alice");
    await db.disconnect();
  });

  test("missing intermediate nested field does not throw", async () => {
    const { db } = makeDb();
    await db.connect();
    const users = db.useCollection("users");
    await users.insertOne({ name: "Alice" }); // no address
    const r = await users.find({ "address.city": "Cairo" });
    expect(r.docs).toHaveLength(0);
    await db.disconnect();
  });

  test("sort option", async () => {
    const { db } = makeDb();
    await db.connect();
    const users = db.useCollection("users");
    await users.insertMany([{ name: "C", age: 3 }, { name: "A", age: 1 }, { name: "B", age: 2 }]);
    const r = await users.find({}, { sort: { age: 1 } });
    expect(r.docs.map(d => d.name)).toEqual(["A", "B", "C"]);
    await db.disconnect();
  });

  test("pagination", async () => {
    const { db } = makeDb();
    await db.connect();
    const items = db.useCollection("items");
    await items.insertMany([1,2,3,4,5].map(n => ({ n })));
    const r = await items.find({}, { page: 2, limit: 2 });
    expect(r.docs).toHaveLength(2);
    expect(r.page).toBe(2);
    expect(r.totalDocs).toBe(5);
    expect(r.totalPages).toBe(3);
    await db.disconnect();
  });

  test("falsy value 0 is not skipped", async () => {
    const { db } = makeDb();
    await db.connect();
    const scores = db.useCollection("scores");
    await scores.insertMany([{ player: "Bob", score: 0 }, { player: "Alice", score: 10 }]);
    const r = await scores.find({ score: 0 });
    expect(r.docs).toHaveLength(1);
    expect(r.docs[0].player).toBe("Bob");
    await db.disconnect();
  });
});

describe("updateOne", () => {
  test("updates matched document", async () => {
    const { db } = makeDb();
    await db.connect();
    const users = db.useCollection("users");
    await users.insertOne({ name: "Alice", score: 10, tags: ["a"] });

    await users.updateOne({ name: "Alice" }, { score: 99 });
    const doc = await users.findOne({ name: "Alice" });
    expect(doc.score).toBe(99);
    await db.disconnect();
  });

  test("$inc increments field in place", async () => {
    const { db } = makeDb();
    await db.connect();
    const users = db.useCollection("users");
    await users.insertOne({ name: "Alice", score: 10 });
    await users.updateOne({ name: "Alice" }, { score: { $inc: 5 } });
    const doc = await users.findOne({ name: "Alice" });
    expect(doc.score).toBe(15);
    await db.disconnect();
  });

  test("$push adds to array", async () => {
    const { db } = makeDb();
    await db.connect();
    const users = db.useCollection("users");
    await users.insertOne({ name: "Alice", tags: ["a"] });
    await users.updateOne({ name: "Alice" }, { tags: { $push: "b" } });
    const doc = await users.findOne({ name: "Alice" });
    expect(doc.tags).toEqual(["a", "b"]);
    await db.disconnect();
  });

  test("returns null when no match", async () => {
    const { db } = makeDb();
    await db.connect();
    const users = db.useCollection("users");
    const result = await users.updateOne({ name: "Ghost" }, { age: 99 });
    expect(result).toBeNull();
    await db.disconnect();
  });
});

describe("updateMany", () => {
  test("updates all matching documents", async () => {
    const { db } = makeDb();
    await db.connect();
    const users = db.useCollection("users");
    await users.insertMany([
      { name: "A", role: "user" },
      { name: "B", role: "user" },
      { name: "C", role: "admin" },
    ]);
    const docs = await users.updateMany({ role: "user" }, { role: "member" });
    expect(docs).toHaveLength(2);
    const r = await users.find({ role: "user" });
    expect(r.docs).toHaveLength(0);
    await db.disconnect();
  });
});

describe("deleteOne", () => {
  test("removes matched document", async () => {
    const { db } = makeDb();
    await db.connect();
    const users = db.useCollection("users");
    await users.insertOne({ name: "Alice" });
    const result = await users.deleteOne({ name: "Alice" });
    expect(result.name).toBe("Alice");
    expect(await users.findOne({ name: "Alice" })).toBeNull();
    await db.disconnect();
  });

  test("returns null when no match", async () => {
    const { db } = makeDb();
    await db.connect();
    const users = db.useCollection("users");
    expect(await users.deleteOne({ name: "Ghost" })).toBeNull();
    await db.disconnect();
  });
});

describe("deleteMany", () => {
  test("removes all matching documents", async () => {
    const { db } = makeDb();
    await db.connect();
    const users = db.useCollection("users");
    await users.insertMany([
      { name: "A", role: "user" },
      { name: "B", role: "user" },
      { name: "C", role: "admin" },
    ]);
    const docs = await users.deleteMany({ role: "user" });
    expect(docs).toHaveLength(2);
    const r = await users.find({});
    expect(r.docs).toHaveLength(1);
    await db.disconnect();
  });
});

// ─── Upsert / ifNotExists ────────────────────────────────────────────────────

describe("upsert", () => {
  test("inserts when no match", async () => {
    const { db } = makeDb();
    await db.connect();
    const users = db.useCollection("users");
    await users.upsert({ name: "Alice" }, { age: 30 });
    const doc = await users.findOne({ name: "Alice" });
    expect(doc).not.toBeNull();
    expect(doc.age).toBe(30);
    await db.disconnect();
  });

  test("updates when match found", async () => {
    const { db } = makeDb();
    await db.connect();
    const users = db.useCollection("users");
    await users.insertOne({ name: "Alice", age: 25 });
    await users.upsert({ name: "Alice" }, { age: 30 });
    const { docs } = await users.find({ name: "Alice" });
    expect(docs).toHaveLength(1);
    expect(docs[0].age).toBe(30);
    await db.disconnect();
  });
});

describe("insertOne ifNotExists", () => {
  test("returns existing doc without inserting duplicate", async () => {
    const { db } = makeDb();
    await db.connect();
    const users = db.useCollection("users");
    await users.insertOne({ name: "Alice", role: "admin" });
    const result = await users.insertOne({ name: "Alice" }, { ifNotExists: true });
    expect(result.role).toBe("admin"); // original doc returned
    const { docs } = await users.find({});
    expect(docs).toHaveLength(1);
    await db.disconnect();
  });
});

// ─── Schema validation ───────────────────────────────────────────────────────

describe("schema validation", () => {
  test("throws on required field missing", async () => {
    const { db } = makeDb();
    await db.connect();
    db.createCollection("users", {
      schema: { name: { type: "string", required: true }, age: "number" },
    });
    const users = db.useCollection("users");
    await expect(users.insertOne({ age: 30 })).rejects.toThrow(/Validation failed/);
    await db.disconnect();
  });

  test("throws on wrong type", async () => {
    const { db } = makeDb();
    await db.connect();
    db.createCollection("items", {
      schema: { price: "number" },
    });
    const items = db.useCollection("items");
    await expect(items.insertOne({ price: "free" })).rejects.toThrow(/Validation failed/);
    await db.disconnect();
  });
});

// ─── Unique constraints ──────────────────────────────────────────────────────

describe("unique index constraints", () => {
  test("throws on duplicate unique field", async () => {
    const { db } = makeDb();
    await db.connect();
    db.createCollection("users", {
      schema: { email: { type: "string", unique: true } },
    });
    const users = db.useCollection("users");
    await users.insertOne({ email: "a@test.com" });
    await expect(users.insertOne({ email: "a@test.com" })).rejects.toThrow(/Unique constraint/);
    await db.disconnect();
  });

  test("updateOne does not throw when updating non-unique fields on a doc with a unique field", async () => {
    // Regression: collection.js passes a shallow copy as oldDoc to IndexEngine.update().
    // Before the _id-based comparison fix, this false-positive threw a unique constraint error.
    const { db } = makeDb();
    await db.connect();
    db.createCollection("users", {
      schema: { email: { type: "string", unique: true } },
    });
    const users = db.useCollection("users");
    await users.insertOne({ email: "alice@test.com", name: "Alice" });
    const updated = await users.updateOne({ email: "alice@test.com" }, { name: "Alice Smith" });
    expect(updated.name).toBe("Alice Smith");
    expect(updated.email).toBe("alice@test.com");
    await db.disconnect();
  });

  test("updateOne throws when changing a unique field to a value already taken by another doc", async () => {
    const { db } = makeDb();
    await db.connect();
    db.createCollection("users", {
      schema: { email: { type: "string", unique: true } },
    });
    const users = db.useCollection("users");
    await users.insertOne({ email: "alice@test.com" });
    await users.insertOne({ email: "bob@test.com" });
    await expect(
      users.updateOne({ email: "bob@test.com" }, { email: "alice@test.com" })
    ).rejects.toThrow(/Unique constraint/);
    await db.disconnect();
  });

  test("updateMany unique conflict does not partially commit", async () => {
    const { db } = makeDb();
    await db.connect();
    db.createCollection("users", {
      schema: {
        email: { type: "string", unique: true },
        group: "string",
      },
    });
    const users = db.useCollection("users");
    const alice = await users.insertOne({ email: "alice@test.com", group: "x" });
    const bob = await users.insertOne({ email: "bob@test.com", group: "x" });

    await expect(
      users.updateMany({ group: "x" }, { email: "shared@test.com" })
    ).rejects.toThrow(/Unique constraint/);

    expect((await users.findOne({ _id: alice._id })).email).toBe("alice@test.com");
    expect((await users.findOne({ _id: bob._id })).email).toBe("bob@test.com");
    await db.disconnect();
  });

  test("updateMany keeps the field index consistent", async () => {
    const { db } = makeDb();
    await db.connect();
    db.createCollection("users", { indexes: ["role"] });
    const users = db.useCollection("users");
    await users.insertMany([
      { name: "Alice", role: "user" },
      { name: "Bob",   role: "user" },
    ]);
    await users.updateMany({ role: "user" }, { role: "member" });
    // Index must reflect the new value
    expect(await users.count({ role: "member" })).toBe(2);
    expect(await users.count({ role: "user" })).toBe(0);
    await db.disconnect();
  });

  test("deleteMany keeps the field index consistent", async () => {
    const { db } = makeDb();
    await db.connect();
    db.createCollection("items", { indexes: ["status"] });
    const items = db.useCollection("items");
    await items.insertMany([
      { name: "A", status: "done" },
      { name: "B", status: "done" },
      { name: "C", status: "active" },
    ]);
    await items.deleteMany({ status: "done" });
    expect(await items.count({})).toBe(1);
    // Index must not return stale entries
    expect(await items.count({ status: "done" })).toBe(0);
    expect(await items.count({ status: "active" })).toBe(1);
    await db.disconnect();
  });
});

// ─── TTL ─────────────────────────────────────────────────────────────────────

describe("TTL documents", () => {
  test("insertOne with ttl sets _expiresAt", async () => {
    const { db } = makeDb();
    await db.connect();
    const sessions = db.useCollection("sessions");
    const data = await sessions.insertOne({ token: "abc" }, { ttl: "1h" });
    expect(data._expiresAt).toBeInstanceOf(Date);
    expect(data._expiresAt.getTime()).toBeGreaterThan(Date.now());
    await db.disconnect();
  });

  test("connect() sweeps expired documents", async () => {
    const adapter = new MemoryAdapter();
    const db1 = new Skalex({ adapter });
    await db1.connect();
    const sessions = db1.useCollection("sessions");
    // Insert an already-expired doc
    await sessions.insertOne({ token: "old", _expiresAt: new Date(Date.now() - 1000) });
    await db1.saveData();
    await db1.disconnect();

    const db2 = new Skalex({ adapter });
    await db2.connect();
    const sessions2 = db2.useCollection("sessions");
    const { docs } = await sessions2.find({});
    expect(docs.find(d => d.token === "old")).toBeUndefined();
    await db2.disconnect();
  });
});

// ─── Persistence ─────────────────────────────────────────────────────────────

describe("persistence", () => {
  test("save and reload preserves documents", async () => {
    const adapter = new MemoryAdapter();
    const db1 = new Skalex({ adapter });
    await db1.connect();
    await db1.useCollection("users").insertOne({ name: "Alice" });
    await db1.saveData();
    await db1.disconnect();

    const db2 = new Skalex({ adapter });
    await db2.connect();
    const doc = await db2.useCollection("users").findOne({ name: "Alice" });
    expect(doc).not.toBeNull();
    expect(doc.name).toBe("Alice");
    await db2.disconnect();
  });

  test("concurrent saves of different collections both persist", async () => {
    const adapter = new MemoryAdapter();
    const db = new Skalex({ adapter });
    await db.connect();
    await db.useCollection("users").insertOne({ name: "Alice" });
    await db.useCollection("orders").insertOne({ item: "Widget" });
    await Promise.all([db.saveData("users"), db.saveData("orders")]);
    await db.disconnect();

    const db2 = new Skalex({ adapter });
    await db2.connect();
    expect(db2.collections.users).toBeDefined();
    expect(db2.collections.orders).toBeDefined();
    await db2.disconnect();
  });

  test("save does not double-serialise (objects not strings after reload)", async () => {
    const adapter = new MemoryAdapter();
    const db1 = new Skalex({ adapter });
    await db1.connect();
    await db1.useCollection("users").insertOne({ name: "Alice" });
    await db1.saveData();
    await db1.disconnect();

    const db2 = new Skalex({ adapter });
    await db2.connect();
    const doc = await db2.useCollection("users").findOne({ name: "Alice" });
    expect(typeof doc).toBe("object");
    expect(doc.name).toBe("Alice");
    await db2.disconnect();
  });

  test("useCollection returns same cached instance", async () => {
    const { db } = makeDb();
    await db.connect();
    const c1 = db.useCollection("users");
    const c2 = db.useCollection("users");
    expect(c1).toBe(c2);
    await db.disconnect();
  });
});

// ─── Transaction ─────────────────────────────────────────────────────────────

describe("transaction", () => {
  test("commits on success", async () => {
    const { db } = makeDb();
    await db.connect();
    await db.useCollection("accounts").insertOne({ name: "Alice", balance: 100 });

    await db.transaction(async (d) => {
      await d.useCollection("accounts").updateOne({ name: "Alice" }, { balance: 200 });
    });

    const doc = await db.useCollection("accounts").findOne({ name: "Alice" });
    expect(doc.balance).toBe(200);
    await db.disconnect();
  });

  test("rolls back on error", async () => {
    const { db } = makeDb();
    await db.connect();
    await db.useCollection("accounts").insertOne({ name: "Alice", balance: 100 });

    await expect(
      db.transaction(async (d) => {
        await d.useCollection("accounts").updateOne({ name: "Alice" }, { balance: 200 });
        throw new Error("intentional failure");
      })
    ).rejects.toThrow("intentional failure");

    const doc = await db.useCollection("accounts").findOne({ name: "Alice" });
    expect(doc.balance).toBe(100); // rolled back
    await db.disconnect();
  });

  test("rolls back collections created inside the transaction", async () => {
    const { db } = makeDb();
    await db.connect();

    await expect(
      db.transaction(async (d) => {
        await d.useCollection("brand_new").insertOne({ x: 1 });
        throw new Error("fail");
      })
    ).rejects.toThrow("fail");

    expect(db.collections["brand_new"]).toBeUndefined();
    await db.disconnect();
  });
});

// ─── Seed ────────────────────────────────────────────────────────────────────

describe("seed", () => {
  test("seeds collections with fixture data", async () => {
    const { db } = makeDb();
    await db.connect();
    await db.seed({
      users: [{ name: "Alice" }, { name: "Bob" }],
      orders: [{ item: "Widget" }],
    });
    const { docs } = await db.useCollection("users").find({});
    expect(docs).toHaveLength(2);
    const orders = await db.useCollection("orders").find({});
    expect(orders.docs).toHaveLength(1);
    await db.disconnect();
  });

  test("reset option clears before seeding", async () => {
    const { db } = makeDb();
    await db.connect();
    await db.useCollection("users").insertMany([{ name: "Old1" }, { name: "Old2" }]);
    await db.seed({ users: [{ name: "New" }] }, { reset: true });
    const { docs } = await db.useCollection("users").find({});
    expect(docs).toHaveLength(1);
    expect(docs[0].name).toBe("New");
    await db.disconnect();
  });
});

// ─── Dump / Inspect ──────────────────────────────────────────────────────────

describe("dump", () => {
  test("returns snapshot of all collections", async () => {
    const { db } = makeDb();
    await db.connect();
    await db.useCollection("users").insertOne({ name: "Alice" });
    const snapshot = db.dump();
    expect(snapshot.users).toHaveLength(1);
    expect(snapshot.users[0].name).toBe("Alice");
    await db.disconnect();
  });
});

describe("inspect", () => {
  test("returns metadata for a single collection", async () => {
    const { db } = makeDb();
    await db.connect();
    db.createCollection("users", { schema: { name: "string" }, indexes: ["role"] });
    await db.useCollection("users").insertMany([{ name: "A" }, { name: "B" }]);
    const info = db.inspect("users");
    expect(info.name).toBe("users");
    expect(info.count).toBe(2);
    expect(info.indexes).toContain("role");
    await db.disconnect();
  });

  test("returns null for unknown collection", async () => {
    const { db } = makeDb();
    await db.connect();
    expect(db.inspect("nonexistent")).toBeNull();
    await db.disconnect();
  });

  test("returns map of all collections when called without args", async () => {
    const { db } = makeDb();
    await db.connect();
    await db.useCollection("a").insertOne({ x: 1 });
    await db.useCollection("b").insertOne({ x: 2 });
    const all = db.inspect();
    expect(all.a).toBeDefined();
    expect(all.b).toBeDefined();
    await db.disconnect();
  });
});

// ─── Namespace ───────────────────────────────────────────────────────────────

describe("namespace", () => {
  test("returns a Skalex instance scoped to a sub-path", () => {
    const db = new Skalex({ path: "/tmp/skalex-ns-test" });
    const ns = db.namespace("tenant1");
    expect(ns).toBeInstanceOf(Skalex);
    expect(ns.dataDirectory).toContain("tenant1");
  });

  test("propagates plugins config to the child instance", async () => {
    const calls = [];
    const plugin = { async afterInsert(ctx) { calls.push(ctx.collection); } };
    const db = new Skalex({ path: "/tmp/skalex-ns-plugins", plugins: [plugin] });
    const ns = db.namespace("ns1");
    await ns.connect();
    await ns.useCollection("logs").insertOne({ msg: "hello" });
    await ns.disconnect();
    expect(calls).toContain("logs");
  });
});

// ─── Migrations ──────────────────────────────────────────────────────────────

describe("migrations", () => {
  test("runs pending migrations on connect", async () => {
    const adapter = new MemoryAdapter();
    const db1 = new Skalex({ adapter });
    let ran = false;
    db1.addMigration({ version: 1, up: async () => { ran = true; } });
    await db1.connect();
    expect(ran).toBe(true);
    await db1.disconnect();
  });

  test("does not re-run already applied migrations", async () => {
    const adapter = new MemoryAdapter();
    let count = 0;

    const db1 = new Skalex({ adapter });
    db1.addMigration({ version: 1, up: async () => { count++; } });
    await db1.connect();
    await db1.saveData();
    await db1.disconnect();

    const db2 = new Skalex({ adapter });
    db2.addMigration({ version: 1, up: async () => { count++; } });
    await db2.connect();
    expect(count).toBe(1); // only ran once
    await db2.disconnect();
  });

  test("migrationStatus reports applied/pending", async () => {
    const { db } = makeDb();
    db.addMigration({ version: 1, up: async () => {} });
    db.addMigration({ version: 2, up: async () => {} });
    await db.connect();
    const status = db.migrationStatus();
    expect(status.applied).toContain(1);
    expect(status.applied).toContain(2);
    expect(status.pending).toHaveLength(0);
    await db.disconnect();
  });

  test("migration that calls collection insertOne does not deadlock", { timeout: 5000 }, async () => {
    const { db } = makeDb();
    db.addMigration({
      version: 1,
      up: async (txDb) => {
        const users = txDb.useCollection("users");
        await users.insertOne({ name: "seed-user" });
      },
    });
    await db.connect();
    const users = db.useCollection("users");
    const result = await users.findOne({ name: "seed-user" });
    expect(result).not.toBeNull();
    expect(result.name).toBe("seed-user");
    await db.disconnect();
  });

  test("migration that calls collection updateOne does not deadlock", { timeout: 5000 }, async () => {
    const adapter = new MemoryAdapter();
    // Pre-seed data so the migration has something to update
    const db1 = new Skalex({ adapter });
    await db1.connect();
    const col = db1.useCollection("config");
    await col.insertOne({ _id: "app", version: 1 }, { save: true });
    await db1.disconnect();

    const db2 = new Skalex({ adapter });
    db2.addMigration({
      version: 1,
      up: async (txDb) => {
        const config = txDb.useCollection("config");
        await config.updateOne({ _id: "app" }, { version: 2 });
      },
    });
    await db2.connect();
    const config = db2.useCollection("config");
    const doc = await config.findOne({ _id: "app" });
    expect(doc.version).toBe(2);
    await db2.disconnect();
  });

  test("failed connect() can be retried after error clears", async () => {
    let shouldFail = true;
    const adapter = new MemoryAdapter();
    const originalList = adapter.list.bind(adapter);
    adapter.list = async () => {
      if (shouldFail) throw new Error("transient disk error");
      return originalList();
    };

    const db = new Skalex({ adapter });
    await expect(db.connect()).rejects.toThrow("transient disk error");
    expect(db.isConnected).toBe(false);

    // Fix the adapter
    shouldFail = false;
    await db.connect();
    expect(db.isConnected).toBe(true);

    // Instance is fully usable
    const col = db.useCollection("test");
    await col.insertOne({ name: "recovery" });
    const doc = await col.findOne({ name: "recovery" });
    expect(doc).not.toBeNull();
    await db.disconnect();
  });
});

// ─── _id integrity ──────────────────────────────────────────────────────────

describe("_id integrity", () => {
  test("insertOne with duplicate _id throws", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    await col.insertOne({ _id: "abc", name: "A" });
    await expect(col.insertOne({ _id: "abc", name: "B" })).rejects.toThrow("Duplicate _id");
    await db.disconnect();
  });

  test("insertMany with duplicate _id in batch throws", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    await expect(col.insertMany([{ _id: "x" }, { _id: "x" }])).rejects.toThrow("Duplicate _id");
    await db.disconnect();
  });

  test("insertMany with _id already in collection throws", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    await col.insertOne({ _id: "y", name: "A" });
    await expect(col.insertMany([{ _id: "y", name: "B" }])).rejects.toThrow("Duplicate _id");
    await db.disconnect();
  });

  test("insertOne with user-supplied unique _id succeeds", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    const doc = await col.insertOne({ _id: "custom-123", name: "A" });
    expect(doc._id).toBe("custom-123");
    const found = await col.findOne({ _id: "custom-123" });
    expect(found.name).toBe("A");
    await db.disconnect();
  });

  test("updateOne cannot mutate _id", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    const doc = await col.insertOne({ name: "A" });
    await col.updateOne({ _id: doc._id }, { _id: "hacked", name: "B" });
    const found = await col.findOne({ _id: doc._id });
    expect(found).not.toBeNull();
    expect(found._id).toBe(doc._id);
    expect(found.name).toBe("B");
    await db.disconnect();
  });

  test("updateOne cannot mutate createdAt", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    const doc = await col.insertOne({ name: "A" });
    const originalCreatedAt = doc.createdAt;
    await col.updateOne({ _id: doc._id }, { createdAt: new Date(0) });
    const found = await col.findOne({ _id: doc._id });
    expect(found.createdAt.getTime()).toBe(originalCreatedAt.getTime());
    await db.disconnect();
  });
});

// ─── Date round-trip ────────────────────────────────────────────────────────

describe("Date round-trip", () => {
  test("Date fields survive save/load round-trip", async () => {
    const adapter = new MemoryAdapter();
    const db = new Skalex({ adapter });
    await db.connect();
    const col = db.useCollection("items");
    const doc = await col.insertOne({ name: "A" }, { save: true });
    expect(doc.createdAt).toBeInstanceOf(Date);
    await db.disconnect();

    const db2 = new Skalex({ adapter });
    await db2.connect();
    const col2 = db2.useCollection("items");
    const loaded = await col2.findOne({ _id: doc._id });
    expect(loaded.createdAt).toBeInstanceOf(Date);
    expect(loaded.updatedAt).toBeInstanceOf(Date);
    expect(loaded.createdAt.getTime()).toBe(doc.createdAt.getTime());
    await db2.disconnect();
  });

  test("User Date fields survive round-trip", async () => {
    const adapter = new MemoryAdapter();
    const db = new Skalex({ adapter });
    await db.connect();
    const col = db.useCollection("items");
    const birthday = new Date("1990-01-15T00:00:00.000Z");
    const doc = await col.insertOne({ birthday }, { save: true });
    await db.disconnect();

    const db2 = new Skalex({ adapter });
    await db2.connect();
    const col2 = db2.useCollection("items");
    const loaded = await col2.findOne({ _id: doc._id });
    expect(loaded.birthday).toBeInstanceOf(Date);
    expect(loaded.birthday.getTime()).toBe(birthday.getTime());
    await db2.disconnect();
  });

  test("BigInt still works after Date fix", async () => {
    const adapter = new MemoryAdapter();
    const db = new Skalex({ adapter });
    await db.connect();
    const col = db.useCollection("items");
    const doc = await col.insertOne({ big: 123456789012345678901234n }, { save: true });
    await db.disconnect();

    const db2 = new Skalex({ adapter });
    await db2.connect();
    const col2 = db2.useCollection("items");
    const loaded = await col2.findOne({ _id: doc._id });
    expect(typeof loaded.big).toBe("bigint");
    expect(loaded.big).toBe(123456789012345678901234n);
    await db2.disconnect();
  });

  test("Nested Date objects survive round-trip", async () => {
    const adapter = new MemoryAdapter();
    const db = new Skalex({ adapter });
    await db.connect();
    const col = db.useCollection("items");
    const lastSeen = new Date("2025-06-15T10:30:00.000Z");
    const doc = await col.insertOne({ meta: { lastSeen } }, { save: true });
    await db.disconnect();

    const db2 = new Skalex({ adapter });
    await db2.connect();
    const col2 = db2.useCollection("items");
    const loaded = await col2.findOne({ _id: doc._id });
    expect(loaded.meta.lastSeen).toBeInstanceOf(Date);
    expect(loaded.meta.lastSeen.getTime()).toBe(lastSeen.getTime());
    await db2.disconnect();
  });
});

// ─── Export ──────────────────────────────────────────────────────────────────

describe("export", () => {
  test("exports JSON via writeRaw", async () => {
    const { db, adapter } = makeDb();
    await db.connect();
    const users = db.useCollection("users");
    await users.insertOne({ name: "Alice", age: 30 });

    await users.export({}, { dir: "/exports", name: "users", format: "json" });

    const raw = adapter.getRaw("/exports/users.json");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw);
    expect(parsed[0].name).toBe("Alice");
    await db.disconnect();
  });

  test("exports CSV via writeRaw", async () => {
    const { db, adapter } = makeDb();
    await db.connect();
    const users = db.useCollection("users");
    await users.insertOne({ name: "Alice", age: 30 });

    await users.export({}, { dir: "/exports", name: "users", format: "csv" });

    const raw = adapter.getRaw("/exports/users.csv");
    expect(raw).toContain("name");
    expect(raw).toContain("Alice");
    await db.disconnect();
  });

  test("throws when no documents match filter", async () => {
    const { db } = makeDb();
    await db.connect();
    const users = db.useCollection("users");
    await users.insertOne({ name: "Alice" });
    await expect(users.export({ name: "Ghost" })).rejects.toThrow(/no documents matched/);
    await db.disconnect();
  });
});

// ─── Import ──────────────────────────────────────────────────────────────────

describe("import", () => {
  test("imports JSON from a file path", async () => {
    const { db, adapter } = makeDb();
    await db.connect();

    // Seed the adapter with a raw JSON file
    adapter._store.set("__raw:/data/products.json", JSON.stringify([
      { name: "Widget", price: 10 },
      { name: "Gadget", price: 20 },
    ]));

    await db.import("/data/products.json", "json");

    const { docs } = await db.useCollection("products").find({});
    expect(docs).toHaveLength(2);
    expect(docs[0].name).toBe("Widget");
    await db.disconnect();
  });

});

// ─── collection.js does not import native fs/path ────────────────────────────

describe("architectural constraints", () => {
  test("collection.js does not require native fs or path", async () => {
    const src = await import("node:fs").then(m => m.promises.readFile(
      new URL("../../src/engine/collection.js", import.meta.url), "utf8"
    ));
    expect(src).not.toMatch(/require\([""]fs[""]\)/);
    expect(src).not.toMatch(/require\([""]path[""]\)/);
  });

  test("Collection exposes _data/_index but not .data/.index", async () => {
    const { db } = makeDb();
    await db.connect();
    const c = db.useCollection("users");
    expect(c._data).toBeDefined();
    expect(c.data).toBeUndefined();
    expect(c._index).toBeDefined();
    expect(c.index).toBeUndefined();
    await db.disconnect();
  });
});

// ─── Vector search ───────────────────────────────────────────────────────────

function makeVectorDb(responses = {}) {
  const adapter = new MemoryAdapter();
  const embeddingAdapter = new MockEmbeddingAdapter(responses);
  const db = new Skalex({ adapter });
  db._embeddingAdapter = embeddingAdapter; // inject mock
  return { db, embeddingAdapter };
}

describe("insertOne / insertMany with { embed }", () => {
  test("insertOne stores _vector on the internal document", async () => {
    const { db } = makeVectorDb({ "hello world": [1, 0, 0, 0] });
    await db.connect();
    const docs = db.useCollection("docs");
    await docs.insertOne({ text: "hello world" }, { embed: "text" });

    // _vector is on the raw store document, not visible via insertOne result
    const raw = docs._data[0];
    expect(raw._vector).toEqual([1, 0, 0, 0]);
    await db.disconnect();
  });

  test("insertOne result does not expose _vector", async () => {
    const { db } = makeVectorDb({ "hello": [0.5, 0.5, 0, 0] });
    await db.connect();
    const docs = db.useCollection("docs");
    const data = await docs.insertOne({ text: "hello" }, { embed: "text" });
    expect(data._vector).toBeUndefined();
    await db.disconnect();
  });

  test("insertOne supports embed as a function", async () => {
    const { db } = makeVectorDb({ "ALICE": [1, 0, 0, 0] });
    await db.connect();
    const docs = db.useCollection("docs");
    await docs.insertOne({ name: "Alice" }, { embed: doc => doc.name.toUpperCase() });
    expect(docs._data[0]._vector).toEqual([1, 0, 0, 0]);
    await db.disconnect();
  });

  test("insertMany embeds each document", async () => {
    const { db, embeddingAdapter } = makeVectorDb();
    await db.connect();
    const docs = db.useCollection("docs");
    await docs.insertMany(
      [{ text: "apple" }, { text: "banana" }, { text: "cherry" }],
      { embed: "text" }
    );
    expect(embeddingAdapter.calls).toEqual(["apple", "banana", "cherry"]);
    expect(docs._data.every(d => d._vector)).toBe(true);
    await db.disconnect();
  });

  test("insertMany result does not expose _vector", async () => {
    const { db } = makeVectorDb();
    await db.connect();
    const docs = db.useCollection("docs");
    const inserted = await docs.insertMany(
      [{ text: "foo" }, { text: "bar" }],
      { embed: "text" }
    );
    expect(inserted.every(d => d._vector === undefined)).toBe(true);
    await db.disconnect();
  });
});

describe("populate", () => {
  test("find() populate resolves foreign key to related document", async () => {
    // Regression: find() was using { [field]: id } instead of { _id: id },
    // so it looked up e.g. { authorId: id } in the authors collection rather than { _id: id }.
    const { db } = makeDb();
    await db.connect();
    const authors = db.useCollection("authors");
    const posts   = db.useCollection("posts");
    const author = await authors.insertOne({ name: "Alice" });
    await posts.insertMany([
      { title: "Post A", authors: author._id },
      { title: "Post B", authors: author._id },
    ]);
    const { docs } = await posts.find({}, { populate: ["authors"] });
    expect(docs).toHaveLength(2);
    expect(docs[0].authors).toMatchObject({ name: "Alice" });
    expect(docs[1].authors).toMatchObject({ name: "Alice" });
    await db.disconnect();
  });

  test("find() populate does not overwrite resolved doc with raw ID", async () => {
    // Regression: Object.assign(newItem, item) ran after populate and overwrote
    // the resolved document with the raw foreign-key string.
    const { db } = makeDb();
    await db.connect();
    const companies = db.useCollection("companies");
    const contacts  = db.useCollection("contacts");
    const company = await companies.insertOne({ name: "Acme" });
    await contacts.insertOne({ name: "Bob", companies: company._id });
    const { docs } = await contacts.find({}, { populate: ["companies"] });
    // Must be the resolved object, not the raw _id string
    expect(typeof docs[0].companies).toBe("object");
    expect(docs[0].companies.name).toBe("Acme");
    await db.disconnect();
  });

  test("findOne() populate resolves foreign key to related document", async () => {
    const { db } = makeDb();
    await db.connect();
    const authors = db.useCollection("authors");
    const posts   = db.useCollection("posts");
    const author = await authors.insertOne({ name: "Carol" });
    await posts.insertOne({ title: "Post C", authors: author._id });
    const doc = await posts.findOne({ title: "Post C" }, { populate: ["authors"] });
    expect(doc.authors).toMatchObject({ name: "Carol" });
    await db.disconnect();
  });

  test("find() populate with select returns both populated and selected fields", async () => {
    const { db } = makeDb();
    await db.connect();
    const teams  = db.useCollection("teams");
    const people = db.useCollection("people");
    const team = await teams.insertOne({ name: "Engineering" });
    await people.insertOne({ name: "Dave", teams: team._id, age: 40 });
    const { docs } = await people.find({}, { populate: ["teams"], select: ["name", "teams"] });
    expect(docs[0].name).toBe("Dave");
    expect(docs[0].teams).toMatchObject({ name: "Engineering" });
    expect(docs[0].age).toBeUndefined(); // not in select
    await db.disconnect();
  });

  test("find() populate with unknown related _id returns original field value", async () => {
    const { db } = makeDb();
    await db.connect();
    const posts = db.useCollection("posts");
    await posts.insertOne({ title: "Orphan", authors: "nonexistent-id" });
    const { docs } = await posts.find({}, { populate: ["authors"] });
    // relatedItem not found  -  field keeps its original value
    expect(docs[0].authors).toBe("nonexistent-id");
    await db.disconnect();
  });
});

describe("find / findOne strip _vector", () => {
  test("findOne does not return _vector", async () => {
    const { db } = makeVectorDb({ "test": [0.1, 0.2, 0.3, 0.4] });
    await db.connect();
    const docs = db.useCollection("docs");
    await docs.insertOne({ text: "test" }, { embed: "text" });
    const doc = await docs.findOne({ text: "test" });
    expect(doc._vector).toBeUndefined();
    await db.disconnect();
  });

  test("find does not return _vector on any doc", async () => {
    const { db } = makeVectorDb();
    await db.connect();
    const docs = db.useCollection("docs");
    await docs.insertMany([{ text: "a" }, { text: "b" }], { embed: "text" });
    const { docs: results } = await docs.find({});
    expect(results.every(d => d._vector === undefined)).toBe(true);
    await db.disconnect();
  });
});

describe("collection.search()", () => {
  test("returns docs ranked by cosine similarity", async () => {
    const { db } = makeVectorDb({
      "cat":  [1, 0, 0, 0],
      "dog":  [0, 1, 0, 0],
      "kitten": [0.9, 0.1, 0, 0],
      "query": [1, 0, 0, 0], // identical to "cat"
    });
    await db.connect();
    const docs = db.useCollection("docs");
    await docs.insertOne({ text: "cat" },    { embed: "text" });
    await docs.insertOne({ text: "dog" },    { embed: "text" });
    await docs.insertOne({ text: "kitten" }, { embed: "text" });

    const { docs: results, scores } = await docs.search("query", { limit: 3 });

    expect(results[0].text).toBe("cat");    // score ≈ 1.0
    expect(results[1].text).toBe("kitten"); // score ≈ 0.99
    expect(results[2].text).toBe("dog");    // score = 0.0
    expect(scores[0]).toBeCloseTo(1.0);
    expect(scores.length).toBe(3);
    await db.disconnect();
  });

  test("respects limit option", async () => {
    const { db } = makeVectorDb({ "q": [1, 0, 0, 0] });
    await db.connect();
    const docs = db.useCollection("docs");
    await docs.insertMany(
      [{ t: "a" }, { t: "b" }, { t: "c" }, { t: "d" }],
      { embed: "t" }
    );
    const { docs: results } = await docs.search("q", { limit: 2 });
    expect(results).toHaveLength(2);
    await db.disconnect();
  });

  test("respects minScore option  -  filters low-similarity docs", async () => {
    const { db } = makeVectorDb({
      "close": [1, 0, 0, 0],
      "far":   [0, 1, 0, 0],
      "q":     [1, 0, 0, 0],
    });
    await db.connect();
    const docs = db.useCollection("docs");
    await docs.insertOne({ text: "close" }, { embed: "text" });
    await docs.insertOne({ text: "far" },   { embed: "text" });

    const { docs: results } = await docs.search("q", { minScore: 0.5 });
    expect(results).toHaveLength(1);
    expect(results[0].text).toBe("close");
    await db.disconnect();
  });

  test("hybrid search  -  filter + vector ranking", async () => {
    const { db } = makeVectorDb({
      "apple": [1, 0, 0, 0],
      "apricot": [0.95, 0.05, 0, 0],
      "banana": [0, 1, 0, 0],
      "q": [1, 0, 0, 0],
    });
    await db.connect();
    const docs = db.useCollection("docs");
    await docs.insertOne({ text: "apple",   category: "fruit-a" }, { embed: "text" });
    await docs.insertOne({ text: "apricot", category: "fruit-a" }, { embed: "text" });
    await docs.insertOne({ text: "banana",  category: "fruit-b" }, { embed: "text" });

    const { docs: results } = await docs.search("q", {
      filter: { category: "fruit-a" },
      limit: 5,
    });

    expect(results).toHaveLength(2);
    expect(results.map(d => d.text)).not.toContain("banana");
    expect(results[0].text).toBe("apple");
    await db.disconnect();
  });

  test("docs without _vector are skipped", async () => {
    const { db } = makeVectorDb({ "q": [1, 0, 0, 0] });
    await db.connect();
    const docs = db.useCollection("docs");
    await docs.insertOne({ text: "no vector" }); // no embed option
    await docs.insertOne({ text: "has vector" }, { embed: "text" });

    const { docs: results } = await docs.search("q");
    expect(results).toHaveLength(1);
    expect(results[0].text).toBe("has vector");
    await db.disconnect();
  });

  test("search results do not expose _vector", async () => {
    const { db } = makeVectorDb({ "q": [1, 0, 0, 0] });
    await db.connect();
    const docs = db.useCollection("docs");
    await docs.insertOne({ text: "q" }, { embed: "text" });
    const { docs: results } = await docs.search("q");
    expect(results[0]._vector).toBeUndefined();
    await db.disconnect();
  });
});

describe("collection.similar()", () => {
  test("returns nearest neighbours by vector", async () => {
    const { db } = makeVectorDb({
      "cat":    [1, 0, 0, 0],
      "kitten": [0.9, 0.1, 0, 0],
      "dog":    [0, 1, 0, 0],
    });
    await db.connect();
    const docs = db.useCollection("docs");
    const cat = await docs.insertOne({ text: "cat" },    { embed: "text" });
    await docs.insertOne({ text: "kitten" }, { embed: "text" });
    await docs.insertOne({ text: "dog" },    { embed: "text" });

    const { docs: results, scores } = await docs.similar(cat._id, { limit: 2 });

    expect(results[0].text).toBe("kitten"); // most similar to cat
    expect(results[1].text).toBe("dog");
    expect(scores[0]).toBeGreaterThan(scores[1]);
    await db.disconnect();
  });

  test("excludes the source document from results", async () => {
    const { db } = makeVectorDb({ "a": [1, 0, 0, 0], "b": [0.8, 0.2, 0, 0] });
    await db.connect();
    const docs = db.useCollection("docs");
    const docA = await docs.insertOne({ text: "a" }, { embed: "text" });
    await docs.insertOne({ text: "b" }, { embed: "text" });

    const { docs: results } = await docs.similar(docA._id);
    expect(results.every(d => d._id !== docA._id)).toBe(true);
    await db.disconnect();
  });

  test("returns empty when id not found", async () => {
    const { db } = makeVectorDb();
    await db.connect();
    const docs = db.useCollection("docs");
    const { docs: results, scores } = await docs.similar("nonexistent");
    expect(results).toHaveLength(0);
    expect(scores).toHaveLength(0);
    await db.disconnect();
  });

  test("returns empty when source doc has no _vector", async () => {
    const { db } = makeVectorDb();
    await db.connect();
    const docs = db.useCollection("docs");
    const doc = await docs.insertOne({ text: "no vector" });
    const { docs: results } = await docs.similar(doc._id);
    expect(results).toHaveLength(0);
    await db.disconnect();
  });

  test("similar results do not expose _vector", async () => {
    const { db } = makeVectorDb({ "a": [1, 0, 0, 0], "b": [0.9, 0.1, 0, 0] });
    await db.connect();
    const docs = db.useCollection("docs");
    const docA = await docs.insertOne({ text: "a" }, { embed: "text" });
    await docs.insertOne({ text: "b" }, { embed: "text" });
    const { docs: results } = await docs.similar(docA._id);
    expect(results[0]._vector).toBeUndefined();
    await db.disconnect();
  });
});

describe("db.embed()", () => {
  test("delegates to the embedding adapter", async () => {
    const { db, embeddingAdapter } = makeVectorDb({ "hello": [0.1, 0.2, 0.3, 0.4] });
    const vector = await db.embed("hello");
    expect(vector).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(embeddingAdapter.calls).toContain("hello");
  });

  test("throws when no AI adapter is configured", async () => {
    const { db } = makeDb();
    await expect(db.embed("test")).rejects.toThrow("requires an AI adapter");
  });
});

// ─── db.ask() ────────────────────────────────────────────────────────────────

function makeAskDbWith(responses) {
  const adapter = new MemoryAdapter();
  const db = new Skalex({ adapter });
  db._aiAdapter = new MockLLMAdapter(responses);
  return db;
}

describe("db.ask()", () => {
  test("translates nlQuery to a filter and returns matching docs", async () => {
    const db = makeAskDbWith({ "users named Alice": { name: "Alice" } });
    await db.connect();
    const users = db.useCollection("users");
    await users.insertOne({ name: "Alice" });
    await users.insertOne({ name: "Bob" });

    const { docs } = await db.ask("users", "users named Alice");
    expect(docs).toHaveLength(1);
    expect(docs[0].name).toBe("Alice");
    await db.disconnect();
  });

  test("caches the filter  -  AI adapter called only once for same query", async () => {
    const db = makeAskDbWith({ "find admins": { role: "admin" } });
    await db.connect();
    const users = db.useCollection("users");
    await users.insertOne({ role: "admin" });

    await db.ask("users", "find admins");
    await db.ask("users", "find admins");

    expect(db._aiAdapter.calls).toHaveLength(1);
    await db.disconnect();
  });

  test("cache is per-collection  -  same query on different collections is a cache miss", async () => {
    const db = makeAskDbWith({ "q": { name: "x" } });
    await db.connect();
    db.useCollection("a");
    db.useCollection("b");

    await db.ask("a", "q");
    await db.ask("b", "q");

    expect(db._aiAdapter.calls).toHaveLength(2);
    await db.disconnect();
  });

  test("respects limit option", async () => {
    const db = makeAskDbWith({ "all": {} });
    await db.connect();
    const col = db.useCollection("items");
    await col.insertMany([{ v: 1 }, { v: 2 }, { v: 3 }, { v: 4 }, { v: 5 }]);

    const { docs } = await db.ask("items", "all", { limit: 3 });
    expect(docs.length).toBeLessThanOrEqual(3);
    await db.disconnect();
  });

  test("throws when no AI adapter is configured", async () => {
    const { db } = makeDb();
    await expect(db.ask("users", "find someone")).rejects.toThrow(/language model adapter/);
  });
});

// ─── db.schema() ─────────────────────────────────────────────────────────────

describe("db.schema()", () => {
  test("returns null for unknown collection", () => {
    const { db } = makeDb();
    expect(db.schema("nonexistent")).toBeNull();
  });

  test("returns declared schema as plain field→type map", async () => {
    const { db } = makeDb();
    await db.connect();
    db.createCollection("users", { schema: { name: "string", age: "number" } });
    const s = db.schema("users");
    expect(s).toEqual({ name: "string", age: "number" });
    await db.disconnect();
  });

  test("infers schema from first document when no schema declared", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    await col.insertOne({ label: "hello", count: 5, active: true });
    const s = db.schema("items");
    expect(s.label).toBe("string");
    expect(s.count).toBe("number");
    expect(s.active).toBe("boolean");
    await db.disconnect();
  });

  test("returns null for empty unschemaed collection", async () => {
    const { db } = makeDb();
    await db.connect();
    db.useCollection("empty");
    expect(db.schema("empty")).toBeNull();
    await db.disconnect();
  });
});
