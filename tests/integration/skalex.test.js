/**
 * Integration tests for Skalex + Collection.
 *
 * All I/O is routed through MemoryAdapter — no file system access in CI.
 */
import { describe, test, expect, beforeEach, vi } from "vitest";
import Skalex from "../../src/index.js";
import MemoryAdapter from "../helpers/MemoryAdapter.js";

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
});

// ─── CRUD ────────────────────────────────────────────────────────────────────

describe("insertOne / findOne", () => {
  test("inserts document with auto _id, createdAt, updatedAt", async () => {
    const { db } = makeDb();
    await db.connect();
    const users = db.useCollection("users");
    const { data } = await users.insertOne({ name: "Alice", age: 30 });

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

  test("findOne _id fast path", async () => {
    const { db } = makeDb();
    await db.connect();
    const users = db.useCollection("users");
    const { data: inserted } = await users.insertOne({ name: "Alice" });
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
    const { docs } = await users.insertMany([{ name: "Alice" }, { name: "Bob" }]);
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
    const { docs } = await users.updateMany({ role: "user" }, { role: "member" });
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
    expect(result.data.name).toBe("Alice");
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
    const { docs } = await users.deleteMany({ role: "user" });
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
    expect(result.data.role).toBe("admin"); // original doc returned
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
});

// ─── TTL ─────────────────────────────────────────────────────────────────────

describe("TTL documents", () => {
  test("insertOne with ttl sets _expiresAt", async () => {
    const { db } = makeDb();
    await db.connect();
    const sessions = db.useCollection("sessions");
    const { data } = await sessions.insertOne({ token: "abc" }, { ttl: "1h" });
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
    const { db } = makeDb();
    const ns = db.namespace("tenant1");
    expect(ns).toBeInstanceOf(Skalex);
    expect(ns.dataDirectory).toContain("tenant1");
  });
});

// ─── Migrations ──────────────────────────────────────────────────────────────

describe("migrations", () => {
  test("runs pending migrations on connect", async () => {
    const adapter = new MemoryAdapter();
    const db1 = new Skalex({ adapter });
    let ran = false;
    db1.addMigration({ version: 1, up: async (col) => { ran = true; } });
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

  test("imports CSV from a file path", async () => {
    const { db, adapter } = makeDb();
    await db.connect();

    adapter._store.set("__raw:/data/items.csv", "name,price\nAlpha,5\nBeta,10");

    await db.import("/data/items.csv", "csv");

    const { docs } = await db.useCollection("items").find({});
    expect(docs).toHaveLength(2);
    expect(docs[0].name).toBe("Alpha");
    await db.disconnect();
  });
});

// ─── collection.js does not import native fs/path ────────────────────────────

describe("architectural constraints", () => {
  test("collection.js does not require native fs or path", async () => {
    const src = await import("node:fs").then(m => m.promises.readFile(
      new URL("../../src/collection.js", import.meta.url), "utf8"
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
