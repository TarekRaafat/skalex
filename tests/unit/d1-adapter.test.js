/**
 * Unit tests for D1Adapter  -  batchSize bounds, chunking behaviour,
 * and chunk-failure semantics.
 */
import { describe, test, expect } from "vitest";
import D1Adapter from "../../src/connectors/storage/d1.js";

// Build a D1 mock whose `prepare()` returns a chainable statement and whose
// `batch()` records chunk sizes. Optionally fails the Nth batch call.
function mockD1({ failOnBatchCall = null } = {}) {
  const calls = [];
  const makeStmt = () => {
    const stmt = {
      bind: () => stmt,
      run: async () => {},
      first: async () => null,
      all: async () => ({ results: [] }),
    };
    return stmt;
  };
  return {
    calls,
    prepare: () => makeStmt(),
    batch: async (stmts) => {
      calls.push(stmts.length);
      if (failOnBatchCall !== null && calls.length === failOnBatchCall) {
        throw new Error("injected batch failure");
      }
    },
  };
}

describe("D1Adapter  -  batchSize option", () => {
  test("default batchSize matches Cloudflare D1's documented per-batch limit (1000)", () => {
    const d1 = mockD1();
    const adapter = new D1Adapter(d1);
    expect(adapter._batchSize).toBe(1000);
  });

  test("rejects zero or negative batchSize", () => {
    const d1 = mockD1();
    expect(() => new D1Adapter(d1, { batchSize: 0 })).toThrow();
    expect(() => new D1Adapter(d1, { batchSize: -1 })).toThrow();
  });

  test("rejects batchSize exceeding Cloudflare's 1000 limit", () => {
    const d1 = mockD1();
    expect(() => new D1Adapter(d1, { batchSize: 1001 })).toThrow(/exceeds Cloudflare D1's documented per-batch limit/);
    expect(() => new D1Adapter(d1, { batchSize: 5000 })).toThrow();
    // Boundary case: exactly 1000 is allowed.
    expect(() => new D1Adapter(d1, { batchSize: 1000 })).not.toThrow();
  });
});

describe("D1Adapter  -  writeAll chunking", () => {
  test("splits writeAll into multiple batches at batchSize", async () => {
    const d1 = mockD1();
    const adapter = new D1Adapter(d1, { batchSize: 10 });
    const entries = Array.from({ length: 25 }, (_, i) => ({ name: `c${i}`, data: "x" }));
    await adapter.writeAll(entries);
    expect(d1.calls).toEqual([10, 10, 5]);
  });

  test("failure on a later chunk aborts without running subsequent chunks", async () => {
    const d1 = mockD1({ failOnBatchCall: 2 });
    const adapter = new D1Adapter(d1, { batchSize: 5 });
    const entries = Array.from({ length: 12 }, (_, i) => ({ name: `c${i}`, data: "x" }));
    await expect(adapter.writeAll(entries)).rejects.toThrow(/injected batch failure/);
    // Calls: chunk 1 of 5 (success), chunk 2 of 5 (fail). No chunk 3.
    expect(d1.calls).toEqual([5, 5]);
  });
});
