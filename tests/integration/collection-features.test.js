/**
 * Integration tests for collection-level v4 features:
 *   autoSave · upsertMany · defaultTtl · defaultEmbed
 *   soft deletes · capped collections · document versioning
 *   collection rename · onSchemaError · strict mode
 *   ttlSweepInterval · db.watch() · write queue
 */
import { describe, test, expect, vi } from "vitest";
import Skalex from "../../src/index.js";
import MemoryAdapter from "../helpers/MemoryAdapter.js";
import MockEmbeddingAdapter from "../helpers/MockEmbeddingAdapter.js";

function makeDb(opts = {}) {
  const adapter = new MemoryAdapter();
  const db = new Skalex({ adapter, ...opts });
  return { db, adapter };
}

// ─── autoSave ────────────────────────────────────────────────────────────────

describe("autoSave", () => {
  test("persists data automatically after insertOne when autoSave: true", async () => {
    const { db, adapter } = makeDb({ autoSave: true });
    await db.connect();
    const users = db.useCollection("users");
    await users.insertOne({ name: "Alice" });
    expect(adapter._store.get("users")).toBeDefined();
    await db.disconnect();
  });

  test("does not persist automatically when autoSave is false (default)", async () => {
    const { db, adapter } = makeDb();
    await db.connect();
    const users = db.useCollection("users");
    await users.insertOne({ name: "Alice" });
    expect(adapter._store.get("users")).toBeUndefined();
    await db.disconnect();
  });

  test("explicit { save: true } persists even when autoSave is false", async () => {
    const { db, adapter } = makeDb();
    await db.connect();
    const users = db.useCollection("users");
    await users.insertOne({ name: "Alice" }, { save: true });
    expect(adapter._store.get("users")).toBeDefined();
    await db.disconnect();
  });

  test("explicit { save: false } suppresses persistence even when autoSave: true", async () => {
    const { db, adapter } = makeDb({ autoSave: true });
    await db.connect();
    const users = db.useCollection("users");
    await users.insertOne({ name: "Alice" }, { save: false });
    expect(adapter._store.get("users")).toBeUndefined();
    await db.disconnect();
  });

  test("autoSave persists on updateOne", async () => {
    const { db, adapter } = makeDb({ autoSave: true });
    await db.connect();
    const users = db.useCollection("users");
    const doc = await users.insertOne({ name: "Alice", score: 0 });
    adapter._store.delete("users"); // clear after insert
    await users.updateOne({ _id: doc._id }, { score: 1 });
    expect(adapter._store.get("users")).toBeDefined();
    await db.disconnect();
  });

  test("autoSave persists on deleteOne", async () => {
    const { db, adapter } = makeDb({ autoSave: true });
    await db.connect();
    const users = db.useCollection("users");
    const doc = await users.insertOne({ name: "Alice" });
    adapter._store.delete("users");
    await users.deleteOne({ _id: doc._id });
    expect(adapter._store.get("users")).toBeDefined();
    await db.disconnect();
  });
});

// ─── upsertMany ──────────────────────────────────────────────────────────────

describe("upsertMany", () => {
  test("inserts new documents when no match exists", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    const result = await col.upsertMany([{ sku: "A", qty: 10 }, { sku: "B", qty: 20 }], "sku");
    expect(result).toHaveLength(2);
    const { docs } = await col.find();
    expect(docs).toHaveLength(2);
    await db.disconnect();
  });

  test("updates existing documents on match", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    await col.insertOne({ sku: "A", qty: 10 });
    await col.upsertMany([{ sku: "A", qty: 99 }, { sku: "B", qty: 5 }], "sku");
    const { docs } = await col.find();
    expect(docs).toHaveLength(2);
    const a = docs.find(d => d.sku === "A");
    expect(a.qty).toBe(99);
    await db.disconnect();
  });

  test("returns the full result array with _id on every doc", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    const result = await col.upsertMany([{ k: 1 }, { k: 2 }, { k: 3 }], "k");
    expect(result).toHaveLength(3);
    expect(result.every(d => d._id)).toBe(true);
    await db.disconnect();
  });

  test("mixed batch: some inserts some updates", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    await col.insertMany([{ code: "X", val: 1 }, { code: "Y", val: 2 }]);
    await col.upsertMany([
      { code: "X", val: 100 }, // update
      { code: "Z", val: 3 },   // insert
    ], "code");
    const { docs } = await col.find();
    expect(docs).toHaveLength(3);
    expect(docs.find(d => d.code === "X").val).toBe(100);
    expect(docs.find(d => d.code === "Z").val).toBe(3);
    await db.disconnect();
  });
});

// ─── defaultTtl ──────────────────────────────────────────────────────────────

describe("defaultTtl per collection", () => {
  test("inserts set _expiresAt automatically when defaultTtl is configured", async () => {
    const { db } = makeDb();
    db.createCollection("tmp", { defaultTtl: "1h" });
    await db.connect();
    const col = db.useCollection("tmp");
    const doc = await col.insertOne({ name: "x" });
    expect(doc._expiresAt).toBeInstanceOf(Date);
    expect(doc._expiresAt.getTime()).toBeGreaterThan(Date.now());
    await db.disconnect();
  });

  test("explicit { ttl } on insertOne takes precedence over defaultTtl", async () => {
    const { db } = makeDb();
    db.createCollection("tmp", { defaultTtl: "1h" });
    await db.connect();
    const col = db.useCollection("tmp");
    const short = await col.insertOne({ name: "short" }, { ttl: "1m" });
    const dflt = await col.insertOne({ name: "dflt" });
    // default TTL (1h) should expire later than the explicit 1m TTL
    expect(dflt._expiresAt.getTime()).toBeGreaterThan(short._expiresAt.getTime());
    await db.disconnect();
  });

  test("insertMany applies defaultTtl to every document", async () => {
    const { db } = makeDb();
    db.createCollection("tmp", { defaultTtl: "30m" });
    await db.connect();
    const col = db.useCollection("tmp");
    const docs = await col.insertMany([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(docs.every(d => d._expiresAt instanceof Date)).toBe(true);
    await db.disconnect();
  });
});

// ─── defaultEmbed ────────────────────────────────────────────────────────────

describe("defaultEmbed per collection", () => {
  test("auto-embeds the specified field on every insertOne", async () => {
    const embeddingAdapter = new MockEmbeddingAdapter();
    const { db } = makeDb({ embeddingAdapter });
    db.createCollection("articles", { defaultEmbed: "content" });
    await db.connect();
    const articles = db.useCollection("articles");
    await articles.insertOne({ title: "Test", content: "Hello world" });
    // _vector stored on the raw document
    const raw = articles._data[0];
    expect(raw._vector).toBeDefined();
    expect(Array.isArray(raw._vector)).toBe(true);
    await db.disconnect();
  });

  test("_vector is not returned to callers", async () => {
    const embeddingAdapter = new MockEmbeddingAdapter();
    const { db } = makeDb({ embeddingAdapter });
    db.createCollection("articles", { defaultEmbed: "content" });
    await db.connect();
    const articles = db.useCollection("articles");
    const doc = await articles.insertOne({ title: "T", content: "hello" });
    expect(doc._vector).toBeUndefined();
    const found = await articles.findOne({ title: "T" });
    expect(found._vector).toBeUndefined();
    await db.disconnect();
  });

  test("auto-embeds on insertMany", async () => {
    const embeddingAdapter = new MockEmbeddingAdapter();
    const { db } = makeDb({ embeddingAdapter });
    db.createCollection("articles", { defaultEmbed: "content" });
    await db.connect();
    const articles = db.useCollection("articles");
    await articles.insertMany([
      { title: "A", content: "alpha" },
      { title: "B", content: "beta" },
    ]);
    expect(articles._data.every(d => Array.isArray(d._vector))).toBe(true);
    await db.disconnect();
  });
});

// ─── Soft Deletes ────────────────────────────────────────────────────────────

describe("soft deletes", () => {
  test("deleteOne stamps _deletedAt instead of removing the document", async () => {
    const { db } = makeDb();
    db.createCollection("posts", { softDelete: true });
    await db.connect();
    const posts = db.useCollection("posts");
    const doc = await posts.insertOne({ title: "Hello" });
    const deleted = await posts.deleteOne({ _id: doc._id });
    expect(deleted._deletedAt).toBeInstanceOf(Date);
    // raw document is still in the data array
    expect(posts._data.find(d => d._id === doc._id)).toBeDefined();
    await db.disconnect();
  });

  test("deleteMany soft-deletes all matching documents", async () => {
    const { db } = makeDb();
    db.createCollection("posts", { softDelete: true });
    await db.connect();
    const posts = db.useCollection("posts");
    await posts.insertMany([{ tag: "x" }, { tag: "x" }, { tag: "y" }]);
    const removed = await posts.deleteMany({ tag: "x" });
    expect(removed).toHaveLength(2);
    expect(removed.every(d => d._deletedAt instanceof Date)).toBe(true);
    await db.disconnect();
  });

  test("find() excludes soft-deleted documents by default", async () => {
    const { db } = makeDb();
    db.createCollection("posts", { softDelete: true });
    await db.connect();
    const posts = db.useCollection("posts");
    await posts.insertMany([{ title: "A" }, { title: "B" }]);
    await posts.deleteOne({ title: "A" });
    const { docs } = await posts.find();
    expect(docs).toHaveLength(1);
    expect(docs[0].title).toBe("B");
    await db.disconnect();
  });

  test("find({ includeDeleted: true }) returns all documents", async () => {
    const { db } = makeDb();
    db.createCollection("posts", { softDelete: true });
    await db.connect();
    const posts = db.useCollection("posts");
    await posts.insertMany([{ title: "A" }, { title: "B" }]);
    await posts.deleteOne({ title: "A" });
    const { docs } = await posts.find({}, { includeDeleted: true });
    expect(docs).toHaveLength(2);
    await db.disconnect();
  });

  test("findOne() excludes soft-deleted documents by default", async () => {
    const { db } = makeDb();
    db.createCollection("posts", { softDelete: true });
    await db.connect();
    const posts = db.useCollection("posts");
    const doc = await posts.insertOne({ title: "A" });
    await posts.deleteOne({ _id: doc._id });
    expect(await posts.findOne({ title: "A" })).toBeNull();
    await db.disconnect();
  });

  test("findOne({ includeDeleted: true }) finds soft-deleted document", async () => {
    const { db } = makeDb();
    db.createCollection("posts", { softDelete: true });
    await db.connect();
    const posts = db.useCollection("posts");
    const doc = await posts.insertOne({ title: "A" });
    await posts.deleteOne({ _id: doc._id });
    const found = await posts.findOne({ title: "A" }, { includeDeleted: true });
    expect(found).not.toBeNull();
    expect(found._deletedAt).toBeInstanceOf(Date);
    await db.disconnect();
  });

  test("restore() clears _deletedAt and makes document visible again", async () => {
    const { db } = makeDb();
    db.createCollection("posts", { softDelete: true });
    await db.connect();
    const posts = db.useCollection("posts");
    const doc = await posts.insertOne({ title: "Hello" });
    await posts.deleteOne({ _id: doc._id });
    const restored = await posts.restore({ _id: doc._id });
    expect(restored._deletedAt).toBeUndefined();
    const found = await posts.findOne({ title: "Hello" });
    expect(found).not.toBeNull();
    await db.disconnect();
  });

  test("restore() returns null when document is not found", async () => {
    const { db } = makeDb();
    db.createCollection("posts", { softDelete: true });
    await db.connect();
    const posts = db.useCollection("posts");
    expect(await posts.restore({ _id: "nonexistent" })).toBeNull();
    await db.disconnect();
  });

  test("deleteOne returns null (no match) on a soft-delete collection when nothing matches", async () => {
    const { db } = makeDb();
    db.createCollection("posts", { softDelete: true });
    await db.connect();
    const posts = db.useCollection("posts");
    expect(await posts.deleteOne({ title: "Ghost" })).toBeNull();
    await db.disconnect();
  });
});

// ─── Capped Collections ───────────────────────────────────────────────────────

describe("capped collections (maxDocs)", () => {
  test("evicts oldest documents FIFO when maxDocs is exceeded", async () => {
    const { db } = makeDb();
    db.createCollection("log", { maxDocs: 3 });
    await db.connect();
    const log = db.useCollection("log");
    for (let n = 1; n <= 4; n++) await log.insertOne({ n });
    const { docs } = await log.find();
    expect(docs).toHaveLength(3);
    expect(docs.map(d => d.n)).not.toContain(1);
    expect(docs.map(d => d.n)).toContain(4);
    await db.disconnect();
  });

  test("collection never exceeds maxDocs regardless of how many inserts occur", async () => {
    const { db } = makeDb();
    db.createCollection("log", { maxDocs: 5 });
    await db.connect();
    const log = db.useCollection("log");
    for (let i = 0; i < 12; i++) await log.insertOne({ i });
    const { docs } = await log.find();
    expect(docs).toHaveLength(5);
    await db.disconnect();
  });

  test("insertMany evicts correctly when batch pushes count past maxDocs", async () => {
    const { db } = makeDb();
    db.createCollection("log", { maxDocs: 3 });
    await db.connect();
    const log = db.useCollection("log");
    await log.insertMany([{ n: 1 }, { n: 2 }]);
    await log.insertMany([{ n: 3 }, { n: 4 }, { n: 5 }]);
    const { docs } = await log.find();
    expect(docs).toHaveLength(3);
    expect(docs.map(d => d.n)).toEqual(expect.arrayContaining([3, 4, 5]));
    await db.disconnect();
  });

  test("_id index stays consistent after eviction", async () => {
    const { db } = makeDb();
    db.createCollection("log", { maxDocs: 2 });
    await db.connect();
    const log = db.useCollection("log");
    const first = await log.insertOne({ n: 1 });
    await log.insertOne({ n: 2 });
    await log.insertOne({ n: 3 }); // evicts first
    const found = await log.findOne({ _id: first._id });
    expect(found).toBeNull();
    await db.disconnect();
  });
});

// ─── Document Versioning ─────────────────────────────────────────────────────

describe("document versioning", () => {
  test("insertOne sets _version: 1 when versioning: true", async () => {
    const { db } = makeDb();
    db.createCollection("posts", { versioning: true });
    await db.connect();
    const posts = db.useCollection("posts");
    const doc = await posts.insertOne({ title: "v1" });
    expect(doc._version).toBe(1);
    await db.disconnect();
  });

  test("insertMany sets _version: 1 on every document", async () => {
    const { db } = makeDb();
    db.createCollection("posts", { versioning: true });
    await db.connect();
    const posts = db.useCollection("posts");
    const docs = await posts.insertMany([{ title: "A" }, { title: "B" }]);
    expect(docs.every(d => d._version === 1)).toBe(true);
    await db.disconnect();
  });

  test("updateOne increments _version", async () => {
    const { db } = makeDb();
    db.createCollection("posts", { versioning: true });
    await db.connect();
    const posts = db.useCollection("posts");
    const doc = await posts.insertOne({ title: "v1" });
    const updated = await posts.updateOne({ _id: doc._id }, { title: "v2" });
    expect(updated._version).toBe(2);
    await db.disconnect();
  });

  test("multiple updates increment _version sequentially", async () => {
    const { db } = makeDb();
    db.createCollection("posts", { versioning: true });
    await db.connect();
    const posts = db.useCollection("posts");
    const doc = await posts.insertOne({ title: "v1" });
    await posts.updateOne({ _id: doc._id }, { title: "v2" });
    const updated = await posts.updateOne({ _id: doc._id }, { title: "v3" });
    expect(updated._version).toBe(3);
    await db.disconnect();
  });

  test("_version is absent when versioning is not enabled", async () => {
    const { db } = makeDb();
    await db.connect();
    const posts = db.useCollection("posts");
    const doc = await posts.insertOne({ title: "no version" });
    expect(doc._version).toBeUndefined();
    await db.disconnect();
  });
});

// ─── renameCollection ────────────────────────────────────────────────────────

describe("renameCollection", () => {
  test("data is accessible under the new name", async () => {
    const { db } = makeDb();
    await db.connect();
    const users = db.useCollection("users");
    await users.insertOne({ name: "Alice" });
    await db.renameCollection("users", "members");
    const members = db.useCollection("members");
    const { docs } = await members.find();
    expect(docs).toHaveLength(1);
    expect(docs[0].name).toBe("Alice");
    await db.disconnect();
  });

  test("old name is no longer in collections registry", async () => {
    const { db } = makeDb();
    await db.connect();
    db.useCollection("users");
    await db.renameCollection("users", "members");
    expect(db.collections["users"]).toBeUndefined();
    await db.disconnect();
  });

  test("data written under old name is migrated to new key in adapter", async () => {
    const { db, adapter } = makeDb();
    await db.connect();
    const users = db.useCollection("users");
    await users.insertOne({ name: "Alice" }, { save: true });
    await db.renameCollection("users", "members");
    await db.saveData("members");
    expect(adapter._store.get("members")).toBeDefined();
    await db.disconnect();
  });
});

// ─── onSchemaError strategies ────────────────────────────────────────────────

describe("onSchemaError strategies", () => {
  test("'throw' (default) rejects documents with type mismatch", async () => {
    const { db } = makeDb();
    db.createCollection("users", { schema: { name: "string", age: "number" } });
    await db.connect();
    const users = db.useCollection("users");
    await expect(users.insertOne({ name: "Alice", age: "thirty" })).rejects.toThrow(/Validation/);
    await db.disconnect();
  });

  test("'warn' logs a warning but inserts the document unchanged", async () => {
    const warnings = [];
    const { db } = makeDb({
      logger: (msg, level) => { if (level === "warn") warnings.push(msg); },
    });
    db.createCollection("users", {
      schema: { name: "string", age: "number" },
      onSchemaError: "warn",
    });
    await db.connect();
    const users = db.useCollection("users");
    const doc = await users.insertOne({ name: "Alice", age: "thirty" }); // type mismatch
    expect(doc._id).toBeDefined();
    expect(doc.age).toBe("thirty"); // original value retained
    expect(warnings.length).toBeGreaterThan(0);
    await db.disconnect();
  });

  test("'strip' removes type-mismatched fields and inserts cleaned document", async () => {
    const { db } = makeDb();
    db.createCollection("users", {
      schema: { name: "string", age: "number" },
      onSchemaError: "strip",
    });
    await db.connect();
    const users = db.useCollection("users");
    const doc = await users.insertOne({ name: "Alice", age: "thirty" }); // age is wrong type
    expect(doc.name).toBe("Alice");
    expect(doc.age).toBeUndefined();
    await db.disconnect();
  });

  test("'strip' removes undeclared fields when strict: true triggers the error", async () => {
    const { db } = makeDb();
    db.createCollection("users", {
      schema: { name: "string" },
      strict: true,
      onSchemaError: "strip",
    });
    await db.connect();
    const users = db.useCollection("users");
    const doc = await users.insertOne({ name: "Alice", undeclared: "field" });
    expect(doc.name).toBe("Alice");
    expect(doc.undeclared).toBeUndefined();
    await db.disconnect();
  });

  test("'strip' removes enum-violating fields", async () => {
    const { db } = makeDb();
    db.createCollection("users", {
      schema: { name: "string", role: { type: "string", enum: ["admin", "user"] } },
      onSchemaError: "strip",
    });
    await db.connect();
    const users = db.useCollection("users");
    const doc = await users.insertOne({ name: "Alice", role: "superadmin" });
    expect(doc.name).toBe("Alice");
    expect(doc.role).toBeUndefined();
    await db.disconnect();
  });
});

// ─── Strict mode ─────────────────────────────────────────────────────────────

describe("strict mode", () => {
  test("throws on unknown fields when strict: true and onSchemaError: 'throw'", async () => {
    const { db } = makeDb();
    db.createCollection("users", {
      schema: { name: "string" },
      strict: true,
    });
    await db.connect();
    const users = db.useCollection("users");
    await expect(users.insertOne({ name: "Alice", extra: "field" })).rejects.toThrow(/Unknown field/);
    await db.disconnect();
  });

  test("strips unknown fields when strict: true and onSchemaError: 'strip'", async () => {
    const { db } = makeDb();
    db.createCollection("users", {
      schema: { name: "string" },
      strict: true,
      onSchemaError: "strip",
    });
    await db.connect();
    const users = db.useCollection("users");
    const doc = await users.insertOne({ name: "Alice", extra: "field" });
    expect(doc.name).toBe("Alice");
    expect(doc.extra).toBeUndefined();
    await db.disconnect();
  });

  test("allows documents with only schema fields when strict: true", async () => {
    const { db } = makeDb();
    db.createCollection("users", {
      schema: { name: "string", age: "number" },
      strict: true,
    });
    await db.connect();
    const users = db.useCollection("users");
    const doc = await users.insertOne({ name: "Alice", age: 30 });
    expect(doc.name).toBe("Alice");
    expect(doc.age).toBe(30);
    await db.disconnect();
  });

  test("warns about unknown fields when strict: true and onSchemaError: 'warn'", async () => {
    const warnings = [];
    const { db } = makeDb({
      logger: (msg, level) => { if (level === "warn") warnings.push(msg); },
    });
    db.createCollection("users", {
      schema: { name: "string" },
      strict: true,
      onSchemaError: "warn",
    });
    await db.connect();
    const users = db.useCollection("users");
    const doc = await users.insertOne({ name: "Alice", ghost: "field" });
    expect(doc._id).toBeDefined();
    expect(warnings.length).toBeGreaterThan(0);
    await db.disconnect();
  });
});

// ─── ttlSweepInterval ────────────────────────────────────────────────────────

describe("ttlSweepInterval", () => {
  test("connect() starts a sweep timer when ttlSweepInterval is configured", async () => {
    vi.useFakeTimers();
    try {
      const { db } = makeDb({ ttlSweepInterval: 1000 });
      await db.connect();
      expect(db._ttlTimer).toBeDefined();
      await db.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });

  test("disconnect() clears the sweep timer", async () => {
    vi.useFakeTimers();
    try {
      const { db } = makeDb({ ttlSweepInterval: 1000 });
      await db.connect();
      await db.disconnect();
      expect(db._ttlTimer).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test("no timer is started when ttlSweepInterval is not set", async () => {
    const { db } = makeDb();
    await db.connect();
    expect(db._ttlTimer).toBeFalsy();
    await db.disconnect();
  });

  test("sweep timer removes expired documents at each interval", async () => {
    vi.useFakeTimers();
    try {
      const { db } = makeDb({ ttlSweepInterval: 1000 });
      db.createCollection("cache");
      await db.connect();
      const cache = db.useCollection("cache");

      const now = Date.now();
      await cache.insertOne({ v: 1 }, { ttl: "500ms" });
      await cache.insertOne({ v: 2 }, { ttl: "2h" });

      // Advance system time past the 500ms expiry and trigger the interval
      vi.setSystemTime(now + 2000);
      vi.advanceTimersByTime(1000);

      const { docs } = await cache.find();
      expect(docs).toHaveLength(1);
      expect(docs[0].v).toBe(2);
      await db.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── db.watch()  -  global cross-collection observer ───────────────────────────

describe("db.watch()", () => {
  test("fires for insertOne on any collection", async () => {
    const { db } = makeDb();
    await db.connect();
    const events = [];
    db.watch(e => events.push(e));
    const posts = db.useCollection("posts");
    const users = db.useCollection("users");
    await posts.insertOne({ title: "Hello" });
    await users.insertOne({ name: "Alice" });
    expect(events).toHaveLength(2);
    expect(events[0].collection).toBe("posts");
    expect(events[1].collection).toBe("users");
    await db.disconnect();
  });

  test("fires for update and delete operations", async () => {
    const { db } = makeDb();
    await db.connect();
    const ops = [];
    db.watch(e => ops.push(e.op));
    const col = db.useCollection("items");
    const doc = await col.insertOne({ v: 1 });
    await col.updateOne({ _id: doc._id }, { v: 2 });
    await col.deleteOne({ _id: doc._id });
    expect(ops).toEqual(["insert", "update", "delete"]);
    await db.disconnect();
  });

  test("returns an unsubscribe function that stops delivery", async () => {
    const { db } = makeDb();
    await db.connect();
    const events = [];
    const unsub = db.watch(e => events.push(e));
    const col = db.useCollection("items");
    await col.insertOne({ v: 1 });
    unsub();
    await col.insertOne({ v: 2 });
    expect(events).toHaveLength(1);
    await db.disconnect();
  });

  test("event payload includes collection, op, and doc", async () => {
    const { db } = makeDb();
    await db.connect();
    let captured;
    db.watch(e => { captured = e; });
    const col = db.useCollection("items");
    await col.insertOne({ name: "test" });
    expect(captured.op).toBe("insert");
    expect(captured.collection).toBe("items");
    expect(captured.doc.name).toBe("test");
    await db.disconnect();
  });

  test("multiple global watchers all fire independently", async () => {
    const { db } = makeDb();
    await db.connect();
    const a = [], b = [];
    db.watch(e => a.push(e));
    db.watch(e => b.push(e));
    const col = db.useCollection("items");
    await col.insertOne({ v: 1 });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    await db.disconnect();
  });

  test("collection.watch() and db.watch() both fire for the same mutation", async () => {
    const { db } = makeDb();
    await db.connect();
    const colEvents = [];
    const globalEvents = [];
    const col = db.useCollection("items");
    col.watch(e => colEvents.push(e));
    db.watch(e => globalEvents.push(e));
    await col.insertOne({ v: 1 });
    expect(colEvents).toHaveLength(1);
    expect(globalEvents).toHaveLength(1);
    await db.disconnect();
  });
});

// ─── Write queue ─────────────────────────────────────────────────────────────

describe("write queue", () => {
  test("concurrent saves do not corrupt data", async () => {
    const { db, adapter } = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    await Promise.all([
      col.insertOne({ n: 1 }, { save: true }),
      col.insertOne({ n: 2 }, { save: true }),
      col.insertOne({ n: 3 }, { save: true }),
    ]);
    const { docs } = await col.find();
    expect(docs).toHaveLength(3);
    const stored = adapter._store.get("items");
    const parsed = JSON.parse(stored);
    expect(parsed.data).toHaveLength(3);
    await db.disconnect();
  });

  test("_pendingSave flag triggers a follow-up save after the first flush", async () => {
    const { db, adapter } = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    // Insert with save: true twice in quick succession
    const p1 = col.insertOne({ n: 1 }, { save: true });
    const p2 = col.insertOne({ n: 2 }, { save: true });
    await Promise.all([p1, p2]);
    const stored = adapter._store.get("items");
    const parsed = JSON.parse(stored);
    // Both documents must be reflected in the final persisted snapshot
    expect(parsed.data.length).toBeGreaterThanOrEqual(2);
    await db.disconnect();
  });
});

// ─── Schema enforcement on updates ──────────────────────────────────────────

describe("schema enforcement on updates", () => {
  test("updateOne rejects invalid type when onSchemaError: 'throw'", async () => {
    const { db } = makeDb();
    db.createCollection("users", { schema: { name: "string", score: "number" } });
    await db.connect();
    const users = db.useCollection("users");
    const doc = await users.insertOne({ name: "Alice", score: 10 });
    await expect(users.updateOne({ _id: doc._id }, { score: "not-a-number" })).rejects.toThrow(/validation/i);
    // Verify document is unchanged after rollback
    const found = await users.findOne({ _id: doc._id });
    expect(found.score).toBe(10);
    await db.disconnect();
  });

  test("updateOne rejects unknown field in strict mode", async () => {
    const { db } = makeDb();
    db.createCollection("users", { schema: { name: "string" }, strict: true });
    await db.connect();
    const users = db.useCollection("users");
    const doc = await users.insertOne({ name: "Alice" });
    await expect(users.updateOne({ _id: doc._id }, { rogue: "field" })).rejects.toThrow(/validation/i);
    const found = await users.findOne({ _id: doc._id });
    expect(found.rogue).toBeUndefined();
    await db.disconnect();
  });

  test("updateOne allows valid update", async () => {
    const { db } = makeDb();
    db.createCollection("users", { schema: { name: "string", score: "number" } });
    await db.connect();
    const users = db.useCollection("users");
    const doc = await users.insertOne({ name: "Alice", score: 10 });
    const updated = await users.updateOne({ _id: doc._id }, { score: 20 });
    expect(updated.score).toBe(20);
    await db.disconnect();
  });

  test("updateOne warns but proceeds when onSchemaError: 'warn'", async () => {
    const warnings = [];
    const { db } = makeDb({
      logger: (msg, level) => { if (level === "warn") warnings.push(msg); },
    });
    db.createCollection("users", {
      schema: { name: "string", score: "number" },
      onSchemaError: "warn",
    });
    await db.connect();
    const users = db.useCollection("users");
    const doc = await users.insertOne({ name: "Alice", score: 10 });
    const updated = await users.updateOne({ _id: doc._id }, { score: "bad" });
    expect(updated.score).toBe("bad");
    expect(warnings.some(w => w.includes("validation"))).toBe(true);
    await db.disconnect();
  });

  test("updateMany stops on first validation error with throw mode", async () => {
    const { db } = makeDb();
    db.createCollection("users", { schema: { name: "string", score: "number" } });
    await db.connect();
    const users = db.useCollection("users");
    await users.insertOne({ name: "A", score: 1 });
    await users.insertOne({ name: "B", score: 2 });
    await expect(users.updateMany({}, { score: "bad" })).rejects.toThrow(/validation/i);
    await db.disconnect();
  });

  test("updateMany rolls back ALL docs when a later doc fails validation", async () => {
    const { db } = makeDb();
    db.createCollection("items", { schema: { name: "string", score: "number" } });
    await db.connect();
    const col = db.useCollection("items");
    const a = await col.insertOne({ name: "A", score: 1 });
    const b = await col.insertOne({ name: "B", score: 2 });
    // Both docs will fail, but the first one is mutated before the second is checked.
    // After throw, ALL docs must be rolled back.
    await expect(col.updateMany({}, { score: "bad" })).rejects.toThrow(/validation/i);
    const foundA = await col.findOne({ _id: a._id });
    const foundB = await col.findOne({ _id: b._id });
    expect(foundA.score).toBe(1);
    expect(foundB.score).toBe(2);
    await db.disconnect();
  });

  test("updateMany rollback also reverts field indexes", async () => {
    const { db } = makeDb();
    db.createCollection("items", {
      schema: { name: "string", score: "number" },
      indexes: ["name"],
    });
    await db.connect();
    const col = db.useCollection("items");
    await col.insertOne({ name: "A", score: 1 });
    await col.insertOne({ name: "B", score: 2 });
    // Try to update name (indexed) + score (will fail validation)
    await expect(col.updateMany({}, { name: "Z", score: "bad" })).rejects.toThrow(/validation/i);
    // Original indexed values must still be queryable
    const foundA = await col.findOne({ name: "A" });
    const foundB = await col.findOne({ name: "B" });
    expect(foundA).not.toBeNull();
    expect(foundB).not.toBeNull();
    // Transient value must NOT be in the index
    const foundZ = await col.findOne({ name: "Z" });
    expect(foundZ).toBeNull();
    await db.disconnect();
  });

  test("updateMany rollback reverts in-place $push mutations", async () => {
    const { db } = makeDb();
    db.createCollection("items", { schema: { tags: "array", score: "number" } });
    await db.connect();
    const col = db.useCollection("items");
    const a = await col.insertOne({ tags: ["a"], score: 1 });
    const b = await col.insertOne({ tags: ["b"], score: 2 });
    // $push mutates the array in place; score: "bad" will fail validation
    await expect(col.updateMany({}, { tags: { $push: "new" }, score: "bad" })).rejects.toThrow(/validation/i);
    const foundA = await col.findOne({ _id: a._id });
    const foundB = await col.findOne({ _id: b._id });
    // Arrays must be restored to original - $push must be undone
    expect(foundA.tags).toEqual(["a"]);
    expect(foundB.tags).toEqual(["b"]);
    await db.disconnect();
  });

  test("updateOne with onSchemaError: 'strip' keeps only valid fields", async () => {
    const { db } = makeDb();
    db.createCollection("users", {
      schema: { name: "string", score: "number" },
      onSchemaError: "strip",
    });
    await db.connect();
    const users = db.useCollection("users");
    const doc = await users.insertOne({ name: "Alice", score: 10 });
    // score: "bad" is invalid (wrong type), name: "Bob" is valid
    const updated = await users.updateOne({ _id: doc._id }, { name: "Bob", score: "bad" });
    expect(updated.name).toBe("Bob");    // valid change kept
    expect(updated.score).toBe(10);      // invalid change stripped, original preserved
    await db.disconnect();
  });

  test("updateMany with onSchemaError: 'strip' keeps only valid fields", async () => {
    const { db } = makeDb();
    db.createCollection("items", {
      schema: { name: "string", score: "number" },
      onSchemaError: "strip",
    });
    await db.connect();
    const col = db.useCollection("items");
    await col.insertOne({ name: "A", score: 1 });
    await col.insertOne({ name: "B", score: 2 });
    const results = await col.updateMany({}, { name: "Z", score: "bad" });
    for (const r of results) {
      expect(r.name).toBe("Z");
    }
    // Original scores preserved - invalid change stripped
    const all = (await col.find({})).docs;
    expect(all[0].score).toBe(1);
    expect(all[1].score).toBe(2);
    await db.disconnect();
  });

  test("upsert update path validates schema", async () => {
    const { db } = makeDb();
    db.createCollection("users", { schema: { name: "string", score: "number" } });
    await db.connect();
    const users = db.useCollection("users");
    await users.insertOne({ name: "Alice", score: 10 });
    await expect(users.upsert({ name: "Alice" }, { score: "bad" })).rejects.toThrow(/validation/i);
    await db.disconnect();
  });
});

// ─── capped collection FIFO eviction emits delete events ────────────────────

describe("capped collection  -  eviction events", () => {
  test("emits delete event for FIFO-evicted documents", async () => {
    const { db } = makeDb();
    await db.connect();
    db.createCollection("cap", { maxDocs: 2 });
    const col = db.useCollection("cap");

    const events = [];
    db.watch((e) => events.push({ op: e.op, id: e.doc?._id, collection: e.collection }));

    const a = await col.insertOne({ n: 1 });
    await col.insertOne({ n: 2 });
    await col.insertOne({ n: 3 }); // evicts `a`

    const deleteEvents = events.filter(e => e.op === "delete");
    expect(deleteEvents).toHaveLength(1);
    expect(deleteEvents[0].id).toBe(a._id);
    expect(col._data).toHaveLength(2);
  });
});

// ─── shared collection context ─────────────────────────────────────────────

describe("Collection  -  shared _ctx reference", () => {
  test("all collection instances share the same ctx reference", async () => {
    const { db } = makeDb();
    await db.connect();
    const a = db.useCollection("a");
    const b = db.useCollection("b");
    expect(a._ctx).toBe(b._ctx);
    expect(a._ctx).toBe(db._collectionContext);
  });

  test("collection instance has no `database` own property", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("users");
    expect(Object.prototype.hasOwnProperty.call(col, "database")).toBe(false);
  });
});

// ─── applyUpdate ignores system-managed fields ─────────────────────────────

describe("Collection  -  applyUpdate discards user-provided updatedAt", () => {
  test("updateOne ignores user-provided updatedAt", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("users");
    const doc = await col.insertOne({ name: "Alice" });
    const fake = new Date("2000-01-01");
    const updated = await col.updateOne({ _id: doc._id }, { name: "Bob", updatedAt: fake });
    expect(new Date(updated.updatedAt).getTime()).not.toBe(fake.getTime());
    expect(updated.name).toBe("Bob");
  });
});

// ─── Public API argument validation ────────────────────────────────────────

describe("Collection  -  argument validation", () => {
  test("insertOne rejects null / primitive / array", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("users");
    await expect(col.insertOne(null)).rejects.toThrow(/plain object/);
    await expect(col.insertOne("string")).rejects.toThrow(/plain object/);
    await expect(col.insertOne(123)).rejects.toThrow(/plain object/);
    await expect(col.insertOne([])).rejects.toThrow(/plain object/);
  });
  test("find rejects non-object filter", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("users");
    await expect(col.find(123)).rejects.toThrow(/filter/);
  });

  // Regression: findOne() with no argument (or null/undefined) used to crash
  // on `filter._id` property access. It now returns the first visible doc,
  // consistent with find({})'s "everything matches" semantics.
  test("findOne() with no / null / undefined filter returns the first visible doc", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("users");
    await col.insertOne({ name: "Alice" });
    await col.insertOne({ name: "Bob" });
    expect((await col.findOne()).name).toBe("Alice");
    expect((await col.findOne(null)).name).toBe("Alice");
    expect((await col.findOne(undefined)).name).toBe("Alice");
  });

  test("findOne() returns null on an empty collection (no filter)", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("users");
    expect(await col.findOne()).toBeNull();
    expect(await col.findOne(null)).toBeNull();
  });
});

// ─── watch-before-after-hook event ordering contract ──────────────────────

describe("Collection  -  watch event / after-hook ordering", () => {
  test("watch event fires before the after-insert plugin hook", async () => {
    const { db } = makeDb();
    const order = [];
    db.use({
      async afterInsert() { order.push("afterInsert"); },
    });
    await db.connect();
    db.watch((e) => { if (e.op === "insert") order.push("watch"); });
    const col = db.useCollection("users");
    await col.insertOne({ name: "Alice" });
    expect(order).toEqual(["watch", "afterInsert"]);
  });
});
