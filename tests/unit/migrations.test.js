import { describe, test, expect } from "vitest";
import MigrationEngine from "../../src/engine/migrations.js";

describe("MigrationEngine", () => {
  function makeEngine(migrations = []) {
    const engine = new MigrationEngine();
    for (const m of migrations) engine.add(m);
    return engine;
  }

  test("add() registers migrations sorted by version", () => {
    const engine = makeEngine([
      { version: 3, up: async () => {} },
      { version: 1, up: async () => {} },
      { version: 2, up: async () => {} },
    ]);
    expect(engine._migrations.map(m => m.version)).toEqual([1, 2, 3]);
  });

  test("add() throws for invalid version", () => {
    const engine = new MigrationEngine();
    expect(() => engine.add({ version: 0, up: async () => {} })).toThrow(/positive integer/);
    expect(() => engine.add({ version: -1, up: async () => {} })).toThrow();
    expect(() => engine.add({ version: "v1", up: async () => {} })).toThrow();
  });

  test("add() throws when no up function", () => {
    const engine = new MigrationEngine();
    expect(() => engine.add({ version: 1 })).toThrow(/"up" function/);
  });

  test("add() throws on duplicate version", () => {
    const engine = new MigrationEngine();
    engine.add({ version: 1, up: async () => {} });
    expect(() => engine.add({ version: 1, up: async () => {} })).toThrow(/already registered/);
  });

  // Stub transaction wrapper for unit tests: runs fn with a stub db and
  // captures each recordApplied payload so we can assert per-migration
  // atomicity without touching persistence.
  function makeHooks() {
    const recorded = [];
    const fakeDb = { useCollection: () => ({}) };
    return {
      recorded,
      runInTx: async (fn) => { await fn(fakeDb); },
      recordApplied: (versions) => { recorded.push([...versions]); },
    };
  }

  test("run() executes only pending migrations", async () => {
    const calls = [];
    const engine = makeEngine([
      { version: 1, up: async () => { calls.push(1); } },
      { version: 2, up: async () => { calls.push(2); } },
      { version: 3, up: async () => { calls.push(3); } },
    ]);
    const hooks = makeHooks();

    // Version 1 already applied
    const applied = await engine.run(hooks, [1]);

    expect(calls).toEqual([2, 3]);
    expect(applied).toEqual([1, 2, 3]);
    // recordApplied was called once per successful migration, with the
    // running sorted list each time.
    expect(hooks.recorded).toEqual([[1, 2], [1, 2, 3]]);
  });

  test("run() returns full sorted applied list", async () => {
    const engine = makeEngine([
      { version: 2, up: async () => {} },
      { version: 4, up: async () => {} },
    ]);
    const hooks = makeHooks();
    const applied = await engine.run(hooks, [1, 3]);
    expect(applied).toEqual([1, 2, 3, 4]);
    expect(hooks.recorded).toEqual([[1, 2, 3], [1, 2, 3, 4]]);
  });

  test("run() passes the db proxy to up()", async () => {
    const seen = [];
    const engine = makeEngine([
      { version: 1, up: async (db) => { seen.push(db); } },
    ]);
    const hooks = makeHooks();
    await engine.run(hooks, []);
    expect(seen[0]).toBeDefined();
    expect(typeof seen[0].useCollection).toBe("function");
  });

  test("run() re-throws if a migration fails and does NOT record its version", async () => {
    const calls = [];
    const engine = makeEngine([
      { version: 1, up: async () => { calls.push(1); } },
      { version: 2, up: async () => { calls.push(2); throw new Error("boom"); } },
      { version: 3, up: async () => { calls.push(3); } },
    ]);
    const hooks = makeHooks();
    await expect(engine.run(hooks, [])).rejects.toThrow(/boom/);
    expect(calls).toEqual([1, 2]);
    // Only migration 1's version was recorded; migration 2 threw before
    // recordApplied could fire, so [1, 2] never appears.
    expect(hooks.recorded).toEqual([[1]]);
  });

  test("status() reports pending and applied correctly", () => {
    const engine = makeEngine([
      { version: 1, up: async () => {} },
      { version: 2, up: async () => {} },
      { version: 3, up: async () => {} },
    ]);
    const status = engine.status([1, 3]);
    expect(status.applied).toEqual([1, 3]);
    expect(status.pending).toEqual([2]);
    expect(status.current).toBe(3);
  });

  test("status() with no applied returns all as pending", () => {
    const engine = makeEngine([{ version: 1, up: async () => {} }]);
    const status = engine.status();
    expect(status.current).toBe(0);
    expect(status.pending).toEqual([1]);
    expect(status.applied).toEqual([]);
  });
});
