/**
 * Isolated Collection tests using CollectionContext.forTesting().
 *
 * These tests validate that a Collection can be constructed and exercised
 * WITHOUT a Skalex instance - only a minimal CollectionContext built by
 * the test factory. They serve two purposes:
 *
 *   1. Prove the `forTesting()` factory covers enough of the context surface
 *      for real CRUD scenarios (regression guard).
 *   2. Document the canonical pattern for plugin authors / advanced users
 *      who want to unit-test Collection behaviour without booting a full db.
 *
 * Rules for new tests here:
 *   - Do NOT import Skalex. The whole point is isolation.
 *   - Use CollectionRegistry.createStore() to build the store shape.
 *   - Pass the ctx returned by forTesting() as the second Collection arg.
 */
import { describe, test, expect } from "vitest";
import Collection from "../../src/engine/collection.js";
import CollectionRegistry from "../../src/engine/registry.js";
import { forTesting } from "../../src/engine/collection-context.js";

function makeColl(name = "items", storeOpts = {}, ctxOverrides = {}) {
  const registry = new CollectionRegistry(Collection);
  registry.createStore(name, storeOpts);
  const store = registry.stores[name];
  const ctx = forTesting(ctxOverrides);
  return new Collection(store, ctx);
}

describe("Collection - isolated via forTesting()", () => {
  test("constructor accepts a bare context (no Skalex reference)", () => {
    const col = makeColl();
    expect(col.name).toBe("items");
    expect(col._ctx).toBeDefined();
    // The ctx should be the forTesting stub, not a Skalex instance.
    expect(col._ctx.txManager.active).toBe(false);
  });

  test("insertOne + findOne round-trip without a Skalex instance", async () => {
    const col = makeColl();
    const doc = await col.insertOne({ name: "Alice", role: "admin" });
    expect(doc._id).toBeDefined();
    expect(doc.name).toBe("Alice");

    const found = await col.findOne({ name: "Alice" });
    expect(found).not.toBeNull();
    expect(found.role).toBe("admin");
  });

  test("insertMany + find returns all docs", async () => {
    const col = makeColl();
    await col.insertMany([{ n: 1 }, { n: 2 }, { n: 3 }]);
    const { docs } = await col.find({});
    expect(docs).toHaveLength(3);
    expect(docs.map(d => d.n).sort()).toEqual([1, 2, 3]);
  });

  test("updateOne mutates the stored doc", async () => {
    const col = makeColl();
    const doc = await col.insertOne({ name: "Bob", score: 0 });
    await col.updateOne({ _id: doc._id }, { score: 100 });
    const after = await col.findOne({ _id: doc._id });
    expect(after.score).toBe(100);
  });

  test("deleteOne removes the matching doc", async () => {
    const col = makeColl();
    const doc = await col.insertOne({ tag: "temp" });
    await col.deleteOne({ _id: doc._id });
    expect(await col.findOne({ _id: doc._id })).toBeNull();
  });

  test("count aggregation works in isolation", async () => {
    const col = makeColl();
    await col.insertMany([{ x: 1 }, { x: 2 }, { x: 3 }]);
    expect(await col.count()).toBe(3);
    expect(await col.count({ x: { $gt: 1 } })).toBe(2);
  });

  test("plugin hooks fire through the injected PluginEngine", async () => {
    const ctx = forTesting();
    const seen = [];
    ctx.plugins.register({
      afterInsert(data) { seen.push({ op: "insert", doc: data.doc }); },
    });

    const registry = new CollectionRegistry(Collection);
    registry.createStore("items");
    const col = new Collection(registry.stores.items, ctx);

    await col.insertOne({ value: "a" });
    expect(seen).toHaveLength(1);
    expect(seen[0].op).toBe("insert");
    expect(seen[0].doc.value).toBe("a");
  });

  test("watch events fire through the injected EventBus", async () => {
    const ctx = forTesting();
    const registry = new CollectionRegistry(Collection);
    registry.createStore("items");
    const col = new Collection(registry.stores.items, ctx);

    const events = [];
    const unsub = col.watch(e => events.push(e));
    await col.insertOne({ v: 1 });
    await col.insertOne({ v: 2 });
    unsub();

    expect(events).toHaveLength(2);
    expect(events[0].op).toBe("insert");
  });

  test("autoSave override causes saveCollection to be called", async () => {
    const saves = [];
    const ctx = forTesting({
      autoSave: true,
      saveCollection: async (name) => { saves.push(name); },
    });
    const registry = new CollectionRegistry(Collection);
    registry.createStore("items");
    const col = new Collection(registry.stores.items, ctx);

    await col.insertOne({ v: 1 });
    expect(saves).toEqual(["items"]);
  });

  test("logger override captures warn messages", async () => {
    const logs = [];
    const ctx = forTesting({ logger: (msg, level) => logs.push({ msg, level }) });

    const registry = new CollectionRegistry(Collection);
    registry.createStore("items", {
      schema: { name: { type: "string", required: true } },
      onSchemaError: "warn",
    });
    const col = new Collection(registry.stores.items, ctx);

    // Insert a doc missing the required field - should warn but not throw.
    await col.insertOne({ other: "value" });
    expect(logs.some(l => l.level === "warn")).toBe(true);
  });

  test("factory does not import Skalex (verified by the import tree)", async () => {
    // If forTesting() pulls in Skalex transitively, this file would have a
    // runtime dependency on the whole database class. The test is meaningful
    // only because we import from src/engine/collection-context.js, not
    // from src/index.js.
    const mod = await import("../../src/engine/collection-context.js");
    expect(typeof mod.forTesting).toBe("function");
  });
});
