/**
 * Unit tests for the PluginEngine + db.use() integration.
 */
import { describe, test, expect } from "vitest";
import PluginEngine from "../../src/features/plugins.js";
import Skalex from "../../src/index.js";
import MemoryAdapter from "../helpers/MemoryAdapter.js";

// --- PluginEngine unit tests --------------------------------------------------

describe("PluginEngine  -  register()", () => {
  test("throws if plugin is not an object", () => {
    const engine = new PluginEngine();
    expect(() => engine.register(null)).toThrow(/Plugin must be a non-null object/);
    expect(() => engine.register("string")).toThrow(/Plugin must be a non-null object/);
    expect(() => engine.register(42)).toThrow(/Plugin must be a non-null object/);
  });

  test("accepts a plain object", () => {
    const engine = new PluginEngine();
    expect(() => engine.register({})).not.toThrow();
  });

  test("size reflects registered plugins", () => {
    const engine = new PluginEngine();
    expect(engine.size).toBe(0);
    engine.register({});
    expect(engine.size).toBe(1);
    engine.register({});
    expect(engine.size).toBe(2);
  });
});

describe("PluginEngine  -  run()", () => {
  test("calls matching hook with context", async () => {
    const engine = new PluginEngine();
    const calls = [];
    engine.register({
      async beforeInsert(ctx) { calls.push(ctx); },
    });
    await engine.run("beforeInsert", { collection: "users", doc: { name: "Alice" } });
    expect(calls).toHaveLength(1);
    expect(calls[0].collection).toBe("users");
  });

  test("skips plugins without the hook", async () => {
    const engine = new PluginEngine();
    const calls = [];
    engine.register({ afterInsert(ctx) { calls.push(ctx); } });
    await engine.run("beforeInsert", { collection: "users", doc: {} }); // different hook
    expect(calls).toHaveLength(0);
  });

  test("calls all matching plugins in order", async () => {
    const engine = new PluginEngine();
    const order = [];
    engine.register({ async beforeInsert() { order.push(1); } });
    engine.register({ async beforeInsert() { order.push(2); } });
    engine.register({ async beforeInsert() { order.push(3); } });
    await engine.run("beforeInsert", {});
    expect(order).toEqual([1, 2, 3]);
  });

  test("awaits async plugins in sequence", async () => {
    const engine = new PluginEngine();
    const order = [];
    engine.register({
      async beforeInsert() {
        await new Promise(r => setTimeout(r, 10));
        order.push("slow");
      },
    });
    engine.register({
      async beforeInsert() { order.push("fast"); },
    });
    await engine.run("beforeInsert", {});
    expect(order).toEqual(["slow", "fast"]);
  });

  test("no-ops when no plugins registered", async () => {
    const engine = new PluginEngine();
    await expect(engine.run("beforeInsert", {})).resolves.not.toThrow();
  });
});

// --- db.use() integration ----------------------------------------------------

function makeDb() {
  return new Skalex({ adapter: new MemoryAdapter() });
}

describe("db.use()  -  throws on bad input", () => {
  test("throws ValidationError for non-object plugin", () => {
    const db = makeDb();
    expect(() => db.use(null)).toThrow(/Plugin must be a non-null object/);
    expect(() => db.use("plugin")).toThrow(/Plugin must be a non-null object/);
  });
});

describe("db.use()  -  beforeInsert / afterInsert", () => {
  test("beforeInsert receives collection and doc before insert", async () => {
    const db = makeDb();
    await db.connect();
    const calls = [];
    db.use({
      async beforeInsert(ctx) { calls.push({ hook: "before", ...ctx }); },
      async afterInsert(ctx)  { calls.push({ hook: "after",  ...ctx }); },
    });
    const col = db.useCollection("users");
    await col.insertOne({ name: "Alice" });
    expect(calls[0].hook).toBe("before");
    expect(calls[0].collection).toBe("users");
    expect(calls[0].doc.name).toBe("Alice");
    expect(calls[1].hook).toBe("after");
    expect(calls[1].doc._id).toBeDefined();
    await db.disconnect();
  });

  test("insertMany fires beforeInsert / afterInsert for each doc", async () => {
    const db = makeDb();
    await db.connect();
    const insertedNames = [];
    db.use({ async afterInsert({ doc }) { insertedNames.push(doc.name); } });
    const col = db.useCollection("users");
    await col.insertMany([{ name: "A" }, { name: "B" }, { name: "C" }]);
    expect(insertedNames).toEqual(["A", "B", "C"]);
    await db.disconnect();
  });
});

describe("db.use()  -  beforeUpdate / afterUpdate", () => {
  test("afterUpdate receives the updated document", async () => {
    const db = makeDb();
    await db.connect();
    const calls = [];
    db.use({ async afterUpdate(ctx) { calls.push(ctx); } });
    const col = db.useCollection("items");
    await col.insertOne({ name: "old" });
    await col.updateOne({ name: "old" }, { name: "new" });
    expect(calls[0].result.name).toBe("new");
    expect(calls[0].collection).toBe("items");
    await db.disconnect();
  });

  test("beforeUpdate receives filter and update descriptor", async () => {
    const db = makeDb();
    await db.connect();
    const calls = [];
    db.use({ async beforeUpdate(ctx) { calls.push(ctx); } });
    const col = db.useCollection("items");
    await col.insertOne({ name: "x" });
    await col.updateOne({ name: "x" }, { score: 99 });
    expect(calls[0].filter).toEqual({ name: "x" });
    expect(calls[0].update).toEqual({ score: 99 });
    await db.disconnect();
  });
});

describe("db.use()  -  beforeDelete / afterDelete", () => {
  test("afterDelete receives the deleted document", async () => {
    const db = makeDb();
    await db.connect();
    const calls = [];
    db.use({ async afterDelete(ctx) { calls.push(ctx); } });
    const col = db.useCollection("items");
    const doc = await col.insertOne({ name: "bye" });
    await col.deleteOne({ _id: doc._id });
    expect(calls[0].result._id).toBe(doc._id);
    await db.disconnect();
  });

  test("beforeDelete receives the filter", async () => {
    const db = makeDb();
    await db.connect();
    const calls = [];
    db.use({ async beforeDelete(ctx) { calls.push(ctx); } });
    const col = db.useCollection("items");
    await col.insertOne({ name: "bye" });
    await col.deleteOne({ name: "bye" });
    expect(calls[0].filter).toEqual({ name: "bye" });
    await db.disconnect();
  });
});

describe("db.use()  -  beforeFind / afterFind", () => {
  test("afterFind receives docs array", async () => {
    const db = makeDb();
    await db.connect();
    const calls = [];
    db.use({ async afterFind(ctx) { calls.push(ctx); } });
    const col = db.useCollection("items");
    await col.insertMany([{ v: 1 }, { v: 2 }]);
    await col.find({});
    expect(calls[0].docs).toHaveLength(2);
    expect(calls[0].collection).toBe("items");
    await db.disconnect();
  });

  test("beforeFind receives filter and options", async () => {
    const db = makeDb();
    await db.connect();
    const calls = [];
    db.use({ async beforeFind(ctx) { calls.push(ctx); } });
    const col = db.useCollection("items");
    await col.find({ v: 1 }, { limit: 5 });
    expect(calls[0].filter).toEqual({ v: 1 });
    expect(calls[0].options).toMatchObject({ limit: 5 });
    await db.disconnect();
  });
});

describe("db.use()  -  multiple plugins", () => {
  test("multiple plugins all receive hooks", async () => {
    const db = makeDb();
    await db.connect();
    const log = [];
    db.use({ async afterInsert() { log.push("plugin-1"); } });
    db.use({ async afterInsert() { log.push("plugin-2"); } });
    const col = db.useCollection("items");
    await col.insertOne({ v: 1 });
    expect(log).toEqual(["plugin-1", "plugin-2"]);
    await db.disconnect();
  });
});


describe("plugin registration across insert phases", () => {
  test("activates hooks on an existing handle after an unobserved insert", async () => {
    const db = makeDb();
    const col = db.useCollection("items");
    await col.insertOne({ _id: "first" });
    const calls = [];
    db.use({
      beforeInsert: ({ doc }) => calls.push("before:" + doc._id),
      afterInsert: ({ doc }) => calls.push("after:" + doc._id),
    });
    await col.insertOne({ _id: "second" });
    expect(calls).toEqual(["before:second", "after:second"]);
    await db.disconnect();
  });

  test("observes after hooks registered by a synchronous watch listener", async () => {
    const db = makeDb();
    const col = db.useCollection("items");
    const calls = [];
    col.watch(() => db.use({ afterInsert: ({ doc }) => calls.push(doc._id) }));
    await col.insertOne({ _id: "first" });
    expect(calls).toEqual(["first"]);
    await db.disconnect();
  });

  test("retains deferred hooks when the first plugin is registered later in a transaction", async () => {
    const db = makeDb();
    await db.connect();
    const calls = [];
    await db.transaction(async tx => {
      await tx.useCollection("items").insertOne({ _id: "owned" });
      db.use({ afterInsert: ({ doc }) => calls.push(doc._id) });
      expect(calls).toEqual([]);
    });
    expect(calls).toEqual(["owned"]);
    await db.disconnect();
  });

  test("keeps checking hook methods on already registered plugin objects", async () => {
    const db = makeDb();
    const plugin = {};
    db.use(plugin);
    const col = db.useCollection("items");
    await col.insertOne({ _id: "first" });
    const calls = [];
    plugin.beforeInsert = ({ doc }) => calls.push("before:" + doc._id);
    plugin.afterInsert = ({ doc }) => calls.push("after:" + doc._id);
    await col.insertOne({ _id: "second" });
    expect(calls).toEqual(["before:second", "after:second"]);
    await db.disconnect();
  });
});


describe("find hook admission", () => {
  test("observes hook methods added after an empty-plugin query", async () => {
    const db = makeDb();
    const col = db.useCollection("items");
    await col.insertOne({ _id: "a" });
    const plugin = {};
    db.use(plugin);
    await col.find({});
    const calls = [];
    plugin.beforeFind = () => calls.push("before");
    plugin.afterFind = ({ docs }) => { calls.push("after"); docs[0].observed = true; };
    expect((await col.find({})).docs[0].observed).toBe(true);
    expect(calls).toEqual(["before", "after"]);
    await db.disconnect();
  });

  test("awaits filter changes and after-hook registration during beforeFind", async () => {
    const db = makeDb();
    const col = db.useCollection("items");
    await col.insertMany([{ _id: "a" }, { _id: "b" }]);
    const calls = [];
    db.use({ beforeFind: async ({ filter }) => {
      await Promise.resolve();
      filter._id = "b";
      db.use({ afterFind: ({ docs }) => calls.push(docs[0]._id) });
    } });
    expect((await col.find({})).docs.map(doc => doc._id)).toEqual(["b"]);
    expect(calls).toEqual(["b"]);
    await db.disconnect();
  });

  test("preserves beforeFind errors without running afterFind", async () => {
    const db = makeDb();
    const col = db.useCollection("items");
    const failure = new TypeError("hook failure");
    let after = false;
    db.use({ beforeFind: () => { throw failure; }, afterFind: () => { after = true; } });
    await expect(col.find({})).rejects.toBe(failure);
    expect(after).toBe(false);
    await db.disconnect();
  });

  test("rejects a handle invalidated by an awaited beforeFind hook", async () => {
    const db = makeDb();
    const col = db.useCollection("items");
    await col.insertOne({ _id: "a" });
    db.use({ beforeFind: () => db.disconnect() });
    await expect(col.find({})).rejects.toMatchObject({ code: "ERR_SKALEX_VALIDATION_STALE_COLLECTION" });
  });
});
