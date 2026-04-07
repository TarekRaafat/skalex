/**
 * Integration tests for previously untested Skalex methods:
 *   transaction · namespace · seed · dump · inspect · import
 *   collection.export · applyUpdate edge cases
 *   search / similar · db.ask() · slowQueryCount / clearSlowQueries
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

// ─── transaction() ───────────────────────────────────────────────────────────

describe("transaction()", () => {
  test("commits all writes when fn resolves", async () => {
    const { db } = makeDb();
    await db.connect();
    await db.transaction(async (tx) => {
      const users  = tx.useCollection("users");
      const orders = tx.useCollection("orders");
      await users.insertOne({ name: "Alice" });
      await orders.insertOne({ item: "Book" });
    });
    expect(await db.useCollection("users").count()).toBe(1);
    expect(await db.useCollection("orders").count()).toBe(1);
    await db.disconnect();
  });

  test("rolls back all mutations when fn throws", async () => {
    const { db } = makeDb();
    await db.connect();
    const users = db.useCollection("users");
    await users.insertOne({ name: "Alice" });

    await expect(
      db.transaction(async (tx) => {
        await tx.useCollection("users").insertOne({ name: "Bob" });
        throw new Error("abort");
      })
    ).rejects.toThrow("abort");

    // Alice still exists, Bob was rolled back
    expect(await users.count()).toBe(1);
    expect(await users.findOne({ name: "Bob" })).toBeNull();
    await db.disconnect();
  });

  test("collections created inside a failed transaction are removed", async () => {
    const { db } = makeDb();
    await db.connect();

    await expect(
      db.transaction(async (tx) => {
        tx.useCollection("temp");
        throw new Error("abort");
      })
    ).rejects.toThrow("abort");

    expect(db.collections["temp"]).toBeUndefined();
    await db.disconnect();
  });

  test("returns the return value of fn", async () => {
    const { db } = makeDb();
    await db.connect();
    const result = await db.transaction(async () => "ok");
    expect(result).toBe("ok");
    await db.disconnect();
  });

  test("rollback restores documents to pre-transaction values", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    const doc = await col.insertOne({ val: 1 });

    await expect(
      db.transaction(async (tx) => {
        await tx.useCollection("items").updateOne({ _id: doc._id }, { val: 99 });
        throw new Error("nope");
      })
    ).rejects.toThrow("nope");

    const found = await col.findOne({ _id: doc._id });
    expect(found.val).toBe(1);
    await db.disconnect();
  });

  test("transaction on a disconnected instance snapshots loaded state before rollback", async () => {
    const adapter = new MemoryAdapter();

    const db1 = new Skalex({ adapter });
    await db1.connect();
    await db1.useCollection("users").insertOne({ name: "Alice" }, { save: true });
    await db1.disconnect();

    const db2 = new Skalex({ adapter });
    await expect(
      db2.transaction(async (tx) => {
        const users = tx.useCollection("users");
        expect((await users.findOne({ name: "Alice" }))?.name).toBe("Alice");
        await users.insertOne({ name: "Bob" });
        throw new Error("abort");
      })
    ).rejects.toThrow("abort");

    const users = db2.useCollection("users");
    expect((await users.findOne({ name: "Alice" }))?.name).toBe("Alice");
    expect(await users.findOne({ name: "Bob" })).toBeNull();
    await db2.disconnect();
  });

  test("autoSave: true does not flush to disk during a failed transaction", async () => {
    class CountingAdapter extends MemoryAdapter {
      constructor() { super(); this.writeCount = 0; }
      async write(name, data) { this.writeCount++; return super.write(name, data); }
    }
    const adapter = new CountingAdapter();
    const db = new Skalex({ adapter, autoSave: true });
    await db.connect();
    // Record writes that happen during connect (e.g. _meta)
    const before = adapter.writeCount;

    await expect(
      db.transaction(async (tx) => {
        await tx.useCollection("items").insertOne({ x: 1 });
        throw new Error("abort");
      })
    ).rejects.toThrow("abort");

    // No additional writes should have occurred during the failed transaction
    expect(adapter.writeCount).toBe(before);
    await db.disconnect();
  });

  test("_inTransaction is true during fn() and false after commit", async () => {
    const { db } = makeDb();
    await db.connect();
    let duringTx;
    await db.transaction(async (tx) => {
      duringTx = db._inTransaction;
      await tx.useCollection("items").insertOne({ x: 1 });
    });
    expect(duringTx).toBe(true);
    expect(db._inTransaction).toBe(false);
    await db.disconnect();
  });

  test("_inTransaction is false after rollback", async () => {
    const { db } = makeDb();
    await db.connect();
    await expect(
      db.transaction(async () => { throw new Error("abort"); })
    ).rejects.toThrow("abort");
    expect(db._inTransaction).toBe(false);
    await db.disconnect();
  });

  test("Date fields are preserved as Date instances after rollback", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("events");
    const ts = new Date("2024-01-01T00:00:00.000Z");
    const doc = await col.insertOne({ ts });

    await expect(
      db.transaction(async (tx) => {
        await tx.useCollection("events").updateOne({ _id: doc._id }, { ts: new Date("2099-01-01") });
        throw new Error("abort");
      })
    ).rejects.toThrow("abort");

    const found = await col.findOne({ _id: doc._id });
    expect(found.ts).toBeInstanceOf(Date);
    expect(found.ts.toISOString()).toBe(ts.toISOString());
    await db.disconnect();
  });

  test("BigInt fields do not crash transaction at snapshot stage", async () => {
    // Use a BigInt-safe custom serializer so saveData() also handles it
    const { db } = makeDb({
      serializer: (v) => JSON.stringify(v, (_, x) =>
        typeof x === "bigint" ? { __bigint__: x.toString() } : x
      ),
      deserializer: (s) => JSON.parse(s, (_, x) =>
        x && typeof x === "object" && "__bigint__" in x ? BigInt(x.__bigint__) : x
      ),
    });
    await db.connect();
    const col = db.useCollection("things");
    await col.insertOne({ n: 9007199254740993n });

    // The transaction snapshot must not throw  -  BigInt used to crash structuredClone
    // when data was serialized through JSON internally.
    await expect(
      db.transaction(async (tx) => {
        await tx.useCollection("things").insertOne({ n: 1n });
        throw new Error("abort");
      })
    ).rejects.toThrow("abort");

    expect(await col.count()).toBe(1);
    await db.disconnect();
  });

  test("TypedArray fields are preserved as TypedArray instances after rollback", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("vecs");
    const vec = new Float32Array([1, 2, 3]);
    const doc = await col.insertOne({ vec });

    await expect(
      db.transaction(async (tx) => {
        await tx.useCollection("vecs").updateOne({ _id: doc._id }, { vec: new Float32Array([4, 5, 6]) });
        throw new Error("abort");
      })
    ).rejects.toThrow("abort");

    const found = await col.findOne({ _id: doc._id });
    expect(found.vec).toBeInstanceOf(Float32Array);
    expect(Array.from(found.vec)).toEqual([1, 2, 3]);
    await db.disconnect();
  });

  test("Map, Set, and RegExp fields are preserved after rollback", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("complex");
    const doc = await col.insertOne({
      m: new Map([["a", 1]]),
      s: new Set([1, 2, 3]),
      r: /hello/i,
    });

    await expect(
      db.transaction(async (tx) => {
        await tx.useCollection("complex").updateOne({ _id: doc._id }, {
          m: new Map([["b", 2]]),
          s: new Set([9]),
          r: /bye/,
        });
        throw new Error("abort");
      })
    ).rejects.toThrow("abort");

    const found = await col.findOne({ _id: doc._id });
    expect(found.m).toBeInstanceOf(Map);
    expect(found.m.get("a")).toBe(1);
    expect(found.s).toBeInstanceOf(Set);
    expect(found.s.has(1)).toBe(true);
    expect(found.r).toBeInstanceOf(RegExp);
    expect(found.r.source).toBe("hello");
    await db.disconnect();
  });

  test("concurrent transactions are serialised  -  no lost updates", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("counter");
    await col.insertOne({ _id: "c", val: 0 });

    // Two concurrent transactions both increment the counter.
    // If they ran in parallel they would both read val=0 and write val=1,
    // losing one increment. Serialisation must produce val=2.
    await Promise.all([
      db.transaction(async (tx) => {
        const c = await tx.useCollection("counter").findOne({ _id: "c" });
        await tx.useCollection("counter").updateOne({ _id: "c" }, { val: c.val + 1 });
      }),
      db.transaction(async (tx) => {
        const c = await tx.useCollection("counter").findOne({ _id: "c" });
        await tx.useCollection("counter").updateOne({ _id: "c" }, { val: c.val + 1 });
      }),
    ]);

    const result = await col.findOne({ _id: "c" });
    expect(result.val).toBe(2);
    await db.disconnect();
  });

  test("db.collections is blocked inside fn() and throws a descriptive error", async () => {
    const { db } = makeDb();
    await db.connect();
    await expect(
      db.transaction(async (tx) => {
        // Accessing tx.collections directly bypasses the snapshot  -  must throw
        void tx.collections;
      })
    ).rejects.toThrow("Direct access to db.collections inside transaction()");
    await db.disconnect();
  });

  test("watch() events are deferred during a transaction and fire once on commit", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    const events = [];
    col.watch(e => events.push(e));

    await db.transaction(async (tx) => {
      await tx.useCollection("items").insertOne({ x: 1 });
      expect(events).toHaveLength(0);
    });

    expect(events).toHaveLength(1);
    expect(events[0].op).toBe("insert");
    await db.disconnect();
  });

  test("watch() events do not fire when a transaction rolls back", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    const events = [];
    col.watch(e => events.push(e));

    await expect(
      db.transaction(async (tx) => {
        await tx.useCollection("items").insertOne({ x: 1 });
        throw new Error("abort");
      })
    ).rejects.toThrow("abort");

    expect(events).toHaveLength(0);
    await db.disconnect();
  });

  test("BigInt fields round-trip through the default serializer on save and load", async () => {
    const { db } = makeDb();
    await db.connect();
    const n = 9007199254740993n;
    await db.useCollection("things").insertOne({ n });

    await db.disconnect();
    await db.connect();

    const found = await db.useCollection("things").findOne({});
    expect(typeof found.n).toBe("bigint");
    expect(found.n).toBe(n);
    await db.disconnect();
  });

  test("restore() inside a transaction defers its event until commit", async () => {
    const { db } = makeDb();
    db.createCollection("posts", { softDelete: true });
    await db.connect();
    const col = db.useCollection("posts");
    const doc = await col.insertOne({ title: "hello" });
    await col.deleteOne({ _id: doc._id });

    const events = [];
    col.watch(e => events.push(e));

    await db.transaction(async (tx) => {
      await tx.useCollection("posts").restore({ _id: doc._id });
      expect(events).toHaveLength(0);
    });

    expect(events).toHaveLength(1);
    expect(events[0].op).toBe("restore");
    const restored = await col.findOne({ _id: doc._id });
    expect(restored).not.toBeNull();
    expect(restored._deletedAt).toBeUndefined();
    await db.disconnect();
  });
});

// ─── namespace() ─────────────────────────────────────────────────────────────

describe("namespace()", () => {
  // Structural tests use a plain Skalex (default FsAdapter)  -  no connection needed.
  function makeFsDb(opts = {}) {
    return new Skalex({ path: "./.db-test-ns", ...opts });
  }

  test("returns a new Skalex instance", () => {
    const db = makeFsDb();
    const ns = db.namespace("tenantA");
    expect(ns).toBeInstanceOf(Skalex);
    expect(ns).not.toBe(db);
  });

  test("sets dataDirectory to parent path + id", () => {
    const db = makeFsDb();
    const ns = db.namespace("tenantA");
    expect(ns.dataDirectory).toBe("./.db-test-ns/tenantA");
  });

  test("inherits format from parent", () => {
    const db = makeFsDb({ format: "json" });
    const ns = db.namespace("ns1");
    expect(ns.dataFormat).toBe("json");
  });

  test("inherits autoSave from parent", () => {
    const db = makeFsDb({ autoSave: true });
    const ns = db.namespace("ns1");
    expect(ns._autoSave).toBe(true);
  });

  test("inherits ttlSweepInterval from parent", () => {
    const db = makeFsDb({ ttlSweepInterval: 5000 });
    const ns = db.namespace("ns1");
    expect(ns._ttlSweepInterval).toBe(5000);
  });

  test("sanitises path-traversal and special characters in id", () => {
    const db = makeFsDb();
    const ns = db.namespace("../../evil/path");
    expect(ns.dataDirectory).not.toContain("..");
    expect(ns.dataDirectory).not.toContain("/evil");
  });

  test("throws when a custom storage adapter is configured", () => {
    const { db } = makeDb(); // makeDb() passes a MemoryAdapter
    expect(() => db.namespace("ns1")).toThrow(/custom storage adapter/);
  });

  test("two independent instances do not share data", async () => {
    const dbA = new Skalex({ adapter: new MemoryAdapter() });
    const dbB = new Skalex({ adapter: new MemoryAdapter() });
    await dbA.connect();
    await dbB.connect();

    await dbA.useCollection("users").insertOne({ name: "Alice" });
    expect(await dbB.useCollection("users").count()).toBe(0);

    await dbA.disconnect();
    await dbB.disconnect();
  });
});

// ─── seed() ──────────────────────────────────────────────────────────────────

describe("seed()", () => {
  test("inserts fixture data into named collections", async () => {
    const { db } = makeDb();
    await db.connect();
    await db.seed({
      users:  [{ name: "Alice" }, { name: "Bob" }],
      orders: [{ item: "Book" }],
    });
    expect(await db.useCollection("users").count()).toBe(2);
    expect(await db.useCollection("orders").count()).toBe(1);
    await db.disconnect();
  });

  test("reset: true clears existing data before seeding", async () => {
    const { db } = makeDb();
    await db.connect();
    const users = db.useCollection("users");
    await users.insertMany([{ name: "Old1" }, { name: "Old2" }]);
    await db.seed({ users: [{ name: "Fresh" }] }, { reset: true });
    const { docs } = await users.find();
    expect(docs).toHaveLength(1);
    expect(docs[0].name).toBe("Fresh");
    await db.disconnect();
  });

  test("seeding without reset appends to existing data", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    await col.insertOne({ v: 1 });
    await db.seed({ items: [{ v: 2 }] });
    expect(await col.count()).toBe(2);
    await db.disconnect();
  });

  test("all seeded documents have _id and timestamps", async () => {
    const { db } = makeDb();
    await db.connect();
    await db.seed({ users: [{ name: "Alice" }] });
    const doc = await db.useCollection("users").findOne({ name: "Alice" });
    expect(doc._id).toBeDefined();
    expect(doc.createdAt).toBeInstanceOf(Date);
    await db.disconnect();
  });
});

// ─── dump() ──────────────────────────────────────────────────────────────────

describe("dump()", () => {
  test("returns a map of collection name to document array", async () => {
    const { db } = makeDb();
    await db.connect();
    await db.useCollection("users").insertOne({ name: "Alice" });
    await db.useCollection("orders").insertOne({ item: "Book" });
    const snapshot = db.dump();
    expect(Array.isArray(snapshot.users)).toBe(true);
    expect(Array.isArray(snapshot.orders)).toBe(true);
    expect(snapshot.users).toHaveLength(1);
    expect(snapshot.orders).toHaveLength(1);
    await db.disconnect();
  });

  test("snapshot is a copy  -  mutations after dump do not affect it", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    await col.insertOne({ v: 1 });
    const snap = db.dump();
    await col.insertOne({ v: 2 });
    // snap.items was taken before the second insert
    expect(snap.items).toHaveLength(1);
    await db.disconnect();
  });

  test("empty database returns an empty object", async () => {
    const { db } = makeDb();
    await db.connect();
    expect(db.dump()).toEqual({});
    await db.disconnect();
  });
});

// ─── inspect() ───────────────────────────────────────────────────────────────

describe("inspect()", () => {
  test("returns metadata for a named collection", async () => {
    const { db } = makeDb();
    db.createCollection("users", { schema: { name: "string" }, softDelete: true, versioning: true });
    await db.connect();
    await db.useCollection("users").insertOne({ name: "Alice" });
    const meta = db.inspect("users");
    expect(meta.name).toBe("users");
    expect(meta.count).toBe(1);
    expect(meta.softDelete).toBe(true);
    expect(meta.versioning).toBe(true);
    expect(meta.schema).toBeDefined();
    await db.disconnect();
  });

  test("returns null for an unknown collection name", async () => {
    const { db } = makeDb();
    await db.connect();
    expect(db.inspect("nonexistent")).toBeNull();
    await db.disconnect();
  });

  test("returns all collections when called with no arguments", async () => {
    const { db } = makeDb();
    await db.connect();
    db.useCollection("a");
    db.useCollection("b");
    const all = db.inspect();
    expect(all.a).toBeDefined();
    expect(all.b).toBeDefined();
    await db.disconnect();
  });

  test("reflects maxDocs and strict in the metadata", async () => {
    const { db } = makeDb();
    db.createCollection("log", { maxDocs: 100, strict: true });
    await db.connect();
    const meta = db.inspect("log");
    expect(meta.maxDocs).toBe(100);
    expect(meta.strict).toBe(true);
    await db.disconnect();
  });

  test("count reflects soft-deleted documents (they are still in data)", async () => {
    const { db } = makeDb();
    db.createCollection("posts", { softDelete: true });
    await db.connect();
    const posts = db.useCollection("posts");
    const doc = await posts.insertOne({ title: "A" });
    await posts.deleteOne({ _id: doc._id });
    // count in inspect = raw data.length (includes soft-deleted)
    expect(db.inspect("posts").count).toBe(1);
    await db.disconnect();
  });
});

// ─── import() ────────────────────────────────────────────────────────────────

describe("import()", () => {
  test("imports a JSON array and inserts documents into a collection named after the file", async () => {
    const { db, adapter } = makeDb();
    await db.connect();
    adapter._store.set("__raw:/data/products.json", JSON.stringify([
      { name: "Widget", price: 10 },
      { name: "Gadget", price: 20 },
    ]));
    const docs = await db.import("/data/products.json");
    expect(docs).toHaveLength(2);
    expect(await db.useCollection("products").count()).toBe(2);
    await db.disconnect();
  });

  test("derives collection name from file name without extension", async () => {
    const { db, adapter } = makeDb();
    await db.connect();
    adapter._store.set("__raw:/export/orders.json", JSON.stringify([{ id: 1 }]));
    await db.import("/export/orders.json");
    expect(await db.useCollection("orders").count()).toBe(1);
    await db.disconnect();
  });

  test("throws on invalid JSON content", async () => {
    const { db, adapter } = makeDb();
    await db.connect();
    adapter._store.set("__raw:/bad.json", "{ not valid json }}}");
    await expect(db.import("/bad.json", "json")).rejects.toThrow(/invalid JSON/i);
    await db.disconnect();
  });
});

// ─── collection.export() ─────────────────────────────────────────────────────

describe("collection.export()", () => {
  test("writes all documents as JSON to the adapter", async () => {
    const { db, adapter } = makeDb();
    await db.connect();
    const col = db.useCollection("users");
    await col.insertMany([{ name: "Alice" }, { name: "Bob" }]);
    await col.export();
    const content = adapter.getRaw("./.db/exports/users.json");
    expect(content).toBeDefined();
    const parsed = JSON.parse(content);
    expect(parsed).toHaveLength(2);
    await db.disconnect();
  });

  test("writes only matching documents when a filter is provided", async () => {
    const { db, adapter } = makeDb();
    await db.connect();
    const col = db.useCollection("users");
    await col.insertMany([{ name: "Alice", role: "admin" }, { name: "Bob", role: "user" }]);
    await col.export({ role: "admin" });
    const content = adapter.getRaw("./.db/exports/users.json");
    const parsed = JSON.parse(content);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("Alice");
    await db.disconnect();
  });

  test("writes CSV format when format: 'csv' is specified", async () => {
    const { db, adapter } = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    await col.insertOne({ name: "Widget", price: 10 });
    await col.export({}, { format: "csv" });
    const content = adapter.getRaw("./.db/exports/items.csv");
    expect(content).toBeDefined();
    expect(content).toContain("name");
    expect(content).toContain("Widget");
    await db.disconnect();
  });

  test("uses custom dir and name when provided", async () => {
    const { db, adapter } = makeDb();
    await db.connect();
    const col = db.useCollection("users");
    await col.insertOne({ name: "Alice" });
    await col.export({}, { dir: "/custom/path", name: "myexport" });
    const content = adapter.getRaw("/custom/path/myexport.json");
    expect(content).toBeDefined();
    await db.disconnect();
  });

  test("throws when no documents match the filter", async () => {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("users");
    await col.insertOne({ name: "Alice" });
    await expect(col.export({ name: "Ghost" })).rejects.toThrow(/no documents matched/i);
    await db.disconnect();
  });
});

// ─── applyUpdate() edge cases ────────────────────────────────────────────────

describe("applyUpdate()  -  edge cases", () => {
  async function getCol(opts = {}) {
    const { db } = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    return { db, col };
  }

  test("$push auto-initialises missing field as an array", async () => {
    const { col } = await getCol();
    const doc = await col.insertOne({ name: "x" });
    const raw = col._data.find(d => d._id === doc._id);
    col.applyUpdate(raw, { tags: { $push: "first" } });
    expect(raw.tags).toEqual(["first"]);
  });

  test("$push appends to an existing array", async () => {
    const { col } = await getCol();
    const doc = await col.insertOne({ tags: ["a"] });
    const raw = col._data.find(d => d._id === doc._id);
    col.applyUpdate(raw, { tags: { $push: "b" } });
    expect(raw.tags).toEqual(["a", "b"]);
  });

  test("$inc on a non-numeric field is silently skipped", async () => {
    const { col } = await getCol();
    const doc = await col.insertOne({ label: "hello" });
    const raw = col._data.find(d => d._id === doc._id);
    col.applyUpdate(raw, { label: { $inc: 5 } });
    expect(raw.label).toBe("hello"); // unchanged
  });

  test("$inc on an undefined field is silently skipped", async () => {
    const { col } = await getCol();
    const doc = await col.insertOne({ name: "x" });
    const raw = col._data.find(d => d._id === doc._id);
    col.applyUpdate(raw, { count: { $inc: 1 } });
    expect(raw.count).toBeUndefined(); // no auto-init for $inc
  });

  test("direct null assignment sets the field to null", async () => {
    const { col } = await getCol();
    const doc = await col.insertOne({ name: "Alice" });
    const raw = col._data.find(d => d._id === doc._id);
    col.applyUpdate(raw, { name: null });
    expect(raw.name).toBeNull();
  });

  test("direct array assignment replaces the field", async () => {
    const { col } = await getCol();
    const doc = await col.insertOne({ tags: ["a"] });
    const raw = col._data.find(d => d._id === doc._id);
    col.applyUpdate(raw, { tags: ["b", "c"] });
    expect(raw.tags).toEqual(["b", "c"]);
  });

  test("applyUpdate always updates updatedAt", async () => {
    const { col } = await getCol();
    const doc = await col.insertOne({ v: 1 });
    const raw = col._data.find(d => d._id === doc._id);
    const before = raw.updatedAt;
    await new Promise(r => setTimeout(r, 5));
    col.applyUpdate(raw, { v: 2 });
    expect(raw.updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });
});

// ─── search() ────────────────────────────────────────────────────────────────

describe("collection.search()", () => {
  function makeVectorDb() {
    const adapter = new MemoryAdapter();
    const embeddingAdapter = new MockEmbeddingAdapter({
      "cat":   [1, 0, 0, 0],
      "dog":   [0.9, 0.436, 0, 0], // ~cosine 0.9 with cat
      "car":   [0, 0, 1, 0],        // orthogonal to cat
      "query": [1, 0, 0, 0],        // identical to cat
    });
    const db = new Skalex({ adapter, embeddingAdapter });
    return { db, embeddingAdapter };
  }

  test("returns empty when collection has no embedded documents", async () => {
    const { db } = makeVectorDb();
    await db.connect();
    const col = db.useCollection("items");
    await col.insertMany([{ title: "no vector" }, { title: "also no vector" }]);
    const { docs, scores } = await col.search("query");
    expect(docs).toHaveLength(0);
    expect(scores).toHaveLength(0);
    await db.disconnect();
  });

  test("returns results ranked by cosine similarity (highest first)", async () => {
    const { db } = makeVectorDb();
    await db.connect();
    const col = db.useCollection("animals");
    await col.insertMany([
      { name: "cat" }, { name: "dog" }, { name: "car" },
    ], { embed: "name" });
    const { docs, scores } = await col.search("query", { limit: 3 });
    expect(docs[0].name).toBe("cat");   // identical vector
    expect(scores[0]).toBeCloseTo(1.0, 4);
    expect(scores[0]).toBeGreaterThan(scores[1]);
    await db.disconnect();
  });

  test("minScore filters out low-similarity results", async () => {
    const { db } = makeVectorDb();
    await db.connect();
    const col = db.useCollection("animals");
    await col.insertMany([
      { name: "cat" }, { name: "car" },
    ], { embed: "name" });
    // "car" has cosine 0 with "query"; setting minScore=0.5 should exclude it
    const { docs } = await col.search("query", { minScore: 0.5 });
    expect(docs.every(d => d.name !== "car")).toBe(true);
    await db.disconnect();
  });

  test("filter option narrows candidates before ranking", async () => {
    const { db } = makeVectorDb();
    await db.connect();
    const col = db.useCollection("animals");
    await col.insertMany([
      { name: "cat",  type: "pet"   },
      { name: "dog",  type: "pet"   },
      { name: "car",  type: "vehicle" },
    ], { embed: "name" });
    const { docs } = await col.search("query", { filter: { type: "pet" } });
    expect(docs.every(d => d.type === "pet")).toBe(true);
    await db.disconnect();
  });

  test("limit caps the number of returned results", async () => {
    const { db } = makeVectorDb();
    await db.connect();
    const col = db.useCollection("animals");
    await col.insertMany([
      { name: "cat" }, { name: "dog" }, { name: "car" },
    ], { embed: "name" });
    const { docs } = await col.search("query", { limit: 2 });
    expect(docs).toHaveLength(2);
    await db.disconnect();
  });

  test("docs and scores arrays have the same length", async () => {
    const { db } = makeVectorDb();
    await db.connect();
    const col = db.useCollection("animals");
    await col.insertOne({ name: "cat" }, { embed: "name" });
    const { docs, scores } = await col.search("query");
    expect(docs).toHaveLength(scores.length);
    await db.disconnect();
  });

  test("_vector is not present in returned docs", async () => {
    const { db } = makeVectorDb();
    await db.connect();
    const col = db.useCollection("animals");
    await col.insertOne({ name: "cat" }, { embed: "name" });
    const { docs } = await col.search("query");
    expect(docs[0]._vector).toBeUndefined();
    await db.disconnect();
  });
});

// ─── similar() ───────────────────────────────────────────────────────────────

describe("collection.similar()", () => {
  function makeVectorDb() {
    const adapter = new MemoryAdapter();
    const embeddingAdapter = new MockEmbeddingAdapter({
      "cat": [1, 0, 0, 0],
      "dog": [0.9, 0.436, 0, 0],
      "car": [0, 0, 1, 0],
    });
    const db = new Skalex({ adapter, embeddingAdapter });
    return db;
  }

  test("returns empty for an unknown id", async () => {
    const db = makeVectorDb();
    await db.connect();
    const col = db.useCollection("animals");
    await col.insertOne({ name: "cat" }, { embed: "name" });
    const { docs, scores } = await col.similar("nonexistent-id");
    expect(docs).toHaveLength(0);
    expect(scores).toHaveLength(0);
    await db.disconnect();
  });

  test("returns empty for a document that has no _vector", async () => {
    const db = makeVectorDb();
    await db.connect();
    const col = db.useCollection("animals");
    const doc = await col.insertOne({ name: "cat" }); // no embed option → no _vector
    const { docs } = await col.similar(doc._id);
    expect(docs).toHaveLength(0);
    await db.disconnect();
  });

  test("excludes the source document from results", async () => {
    const db = makeVectorDb();
    await db.connect();
    const col = db.useCollection("animals");
    const docs = await col.insertMany([
      { name: "cat" }, { name: "dog" }, { name: "car" },
    ], { embed: "name" });
    const catId = docs[0]._id;
    const { docs: results } = await col.similar(catId);
    expect(results.every(d => d._id !== catId)).toBe(true);
    await db.disconnect();
  });

  test("returns results ranked by similarity (highest first)", async () => {
    const db = makeVectorDb();
    await db.connect();
    const col = db.useCollection("animals");
    const inserted = await col.insertMany([
      { name: "cat" }, { name: "dog" }, { name: "car" },
    ], { embed: "name" });
    const catId = inserted[0]._id;
    const { docs, scores } = await col.similar(catId);
    // dog is more similar to cat than car is
    expect(docs[0].name).toBe("dog");
    expect(scores[0]).toBeGreaterThan(scores[1]);
    await db.disconnect();
  });

  test("minScore excludes documents below threshold", async () => {
    const db = makeVectorDb();
    await db.connect();
    const col = db.useCollection("animals");
    const inserted = await col.insertMany([
      { name: "cat" }, { name: "dog" }, { name: "car" },
    ], { embed: "name" });
    const catId = inserted[0]._id;
    // car has cosine 0 with cat → excluded at minScore=0.5
    const { docs } = await col.similar(catId, { minScore: 0.5 });
    expect(docs.every(d => d.name !== "car")).toBe(true);
    await db.disconnect();
  });

  test("_vector is not present in returned docs", async () => {
    const db = makeVectorDb();
    await db.connect();
    const col = db.useCollection("animals");
    const inserted = await col.insertMany([
      { name: "cat" }, { name: "dog" },
    ], { embed: "name" });
    const { docs } = await col.similar(inserted[0]._id);
    expect(docs[0]._vector).toBeUndefined();
    await db.disconnect();
  });
});

// ─── db.ask() ────────────────────────────────────────────────────────────────

describe("db.ask()", () => {
  test("throws when no LLM adapter is configured", async () => {
    const { db } = makeDb();
    await db.connect();
    db.useCollection("users");
    await expect(db.ask("users", "find Alice")).rejects.toThrow(/language model adapter/i);
    await db.disconnect();
  });

  test("translates natural language to a filter and returns matching docs", async () => {
    const llmAdapter = new MockLLMAdapter({ "find admins": { role: "admin" } });
    const { db } = makeDb({ llmAdapter });
    await db.connect();
    const users = db.useCollection("users");
    await users.insertMany([
      { name: "Alice", role: "admin" },
      { name: "Bob",   role: "user" },
    ]);
    const { docs } = await db.ask("users", "find admins");
    expect(docs).toHaveLength(1);
    expect(docs[0].name).toBe("Alice");
    await db.disconnect();
  });

  test("caches results  -  LLM adapter is not called on repeated query", async () => {
    const llmAdapter = new MockLLMAdapter({ "find admins": { role: "admin" } });
    const { db } = makeDb({ llmAdapter });
    await db.connect();
    const users = db.useCollection("users");
    await users.insertOne({ name: "Alice", role: "admin" });
    await db.ask("users", "find admins");
    await db.ask("users", "find admins");
    // generate() should have been called exactly once
    expect(llmAdapter.calls).toHaveLength(1);
    await db.disconnect();
  });
});

// ─── slowQueryCount() / clearSlowQueries() ───────────────────────────────────

describe("slowQueryCount() / clearSlowQueries()", () => {
  test("slowQueryCount() returns 0 when no slow query log is configured", async () => {
    const { db } = makeDb();
    await db.connect();
    expect(db.slowQueryCount()).toBe(0);
    await db.disconnect();
  });

  test("slowQueryCount() reflects recorded slow queries", async () => {
    const { db } = makeDb({ slowQueryLog: { threshold: 0 } }); // threshold=0 records everything
    await db.connect();
    const col = db.useCollection("items");
    await col.insertMany([{ v: 1 }, { v: 2 }]);
    await col.find({});
    expect(db.slowQueryCount()).toBeGreaterThan(0);
    await db.disconnect();
  });

  test("clearSlowQueries() empties the log", async () => {
    const { db } = makeDb({ slowQueryLog: { threshold: 0 } });
    await db.connect();
    const col = db.useCollection("items");
    await col.insertOne({ v: 1 });
    await col.find({});
    expect(db.slowQueryCount()).toBeGreaterThan(0);
    db.clearSlowQueries();
    expect(db.slowQueryCount()).toBe(0);
    await db.disconnect();
  });

  test("clearSlowQueries() is a no-op when no log is configured", () => {
    const { db } = makeDb();
    expect(() => db.clearSlowQueries()).not.toThrow();
  });
});
