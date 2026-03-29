import { describe, test, expect, vi } from "vitest";
import MigrationEngine from "../../src/migrations.js";

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

  test("run() executes only pending migrations", async () => {
    const calls = [];
    const engine = makeEngine([
      { version: 1, up: async (col) => { calls.push(1); } },
      { version: 2, up: async (col) => { calls.push(2); } },
      { version: 3, up: async (col) => { calls.push(3); } },
    ]);

    // Version 1 already applied
    const getCol = vi.fn(() => ({}));
    const applied = await engine.run(getCol, [1]);

    expect(calls).toEqual([2, 3]);
    expect(applied).toEqual([1, 2, 3]);
  });

  test("run() returns full sorted applied list", async () => {
    const engine = makeEngine([
      { version: 2, up: async () => {} },
      { version: 4, up: async () => {} },
    ]);
    const applied = await engine.run(vi.fn(), [1, 3]);
    expect(applied).toEqual([1, 2, 3, 4]);
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
