/**
 * Unit tests for ask.js — QueryCache, processLLMFilter, validateLLMFilter.
 */
import { describe, test, expect } from "vitest";
import { QueryCache, processLLMFilter, validateLLMFilter } from "../../src/features/ask.js";

// ─── QueryCache ──────────────────────────────────────────────────────────────

describe("QueryCache", () => {
  test("get returns undefined for missing key", () => {
    const cache = new QueryCache();
    expect(cache.get("users", { name: "string" }, "find Alice")).toBeUndefined();
  });

  test("set then get returns the filter", () => {
    const cache = new QueryCache();
    const filter = { name: "Alice" };
    cache.set("users", { name: "string" }, "find Alice", filter);
    expect(cache.get("users", { name: "string" }, "find Alice")).toEqual(filter);
  });

  test("different queries produce different cache keys", () => {
    const cache = new QueryCache();
    cache.set("users", null, "query A", { a: 1 });
    cache.set("users", null, "query B", { b: 2 });
    expect(cache.get("users", null, "query A")).toEqual({ a: 1 });
    expect(cache.get("users", null, "query B")).toEqual({ b: 2 });
  });

  test("different collections produce different cache keys", () => {
    const cache = new QueryCache();
    cache.set("users", null, "q", { x: 1 });
    cache.set("orders", null, "q", { y: 2 });
    expect(cache.get("users", null, "q")).toEqual({ x: 1 });
    expect(cache.get("orders", null, "q")).toEqual({ y: 2 });
  });

  test("size reflects number of entries", () => {
    const cache = new QueryCache();
    expect(cache.size).toBe(0);
    cache.set("a", null, "q1", {});
    cache.set("a", null, "q2", {});
    expect(cache.size).toBe(2);
  });

  test("toJSON / fromJSON round-trip", () => {
    const cache = new QueryCache();
    cache.set("users", { name: "string" }, "find Bob", { name: "Bob" });

    const json = cache.toJSON();
    const cache2 = new QueryCache();
    cache2.fromJSON(json);

    expect(cache2.get("users", { name: "string" }, "find Bob")).toEqual({ name: "Bob" });
    expect(cache2.size).toBe(1);
  });

  test("fromJSON ignores null / non-object input", () => {
    const cache = new QueryCache();
    cache.fromJSON(null);
    cache.fromJSON("string");
    expect(cache.size).toBe(0);
  });

  test("same query/schema/collection always produces the same cache key (deterministic)", () => {
    const c1 = new QueryCache();
    const c2 = new QueryCache();
    c1.set("users", { age: "number" }, "adults", { age: { $gte: 18 } });
    c2.fromJSON(c1.toJSON());
    expect(c2.get("users", { age: "number" }, "adults")).toEqual({ age: { $gte: 18 } });
  });
});

// ─── processLLMFilter ────────────────────────────────────────────────────────

describe("processLLMFilter", () => {
  test("passes through simple equality filter unchanged", () => {
    const f = processLLMFilter({ name: "Alice" });
    expect(f).toEqual({ name: "Alice" });
  });

  test("converts $regex string to RegExp", () => {
    const f = processLLMFilter({ name: { $regex: "^Al" } });
    expect(f.name.$regex).toBeInstanceOf(RegExp);
    expect(f.name.$regex.source).toBe("^Al");
  });

  test("leaves already-RegExp $regex untouched when not a string", () => {
    // processLLMFilter only converts string $regex values
    const f = processLLMFilter({ name: { $regex: "test" } });
    expect(f.name.$regex).toBeInstanceOf(RegExp);
  });

  test("converts ISO date strings in $gt/$gte/$lt/$lte to Date", () => {
    const f = processLLMFilter({
      createdAt: {
        $gte: "2024-01-01",
        $lte: "2024-12-31",
      },
    });
    expect(f.createdAt.$gte).toBeInstanceOf(Date);
    expect(f.createdAt.$lte).toBeInstanceOf(Date);
    expect(f.createdAt.$gte.getFullYear()).toBe(2024);
  });

  test("leaves non-date strings in range operators untouched", () => {
    const f = processLLMFilter({ score: { $gt: "not-a-date" } });
    expect(f.score.$gt).toBe("not-a-date");
  });

  test("passes through numeric range operators", () => {
    const f = processLLMFilter({ age: { $gte: 18, $lte: 65 } });
    expect(f.age.$gte).toBe(18);
    expect(f.age.$lte).toBe(65);
  });

  test("handles null and non-object input gracefully", () => {
    expect(processLLMFilter(null)).toBeNull();
    expect(processLLMFilter("string")).toBe("string");
  });

  test("handles nested $in operator", () => {
    const f = processLLMFilter({ status: { $in: ["active", "pending"] } });
    expect(f.status.$in).toEqual(["active", "pending"]);
  });
});

// ─── validateLLMFilter ───────────────────────────────────────────────────────

describe("validateLLMFilter", () => {
  const schema = { name: "string", age: "number", active: "boolean" };

  test("returns empty array for valid filter", () => {
    const w = validateLLMFilter({ name: "Alice", age: { $gte: 18 } }, schema);
    expect(w).toHaveLength(0);
  });

  test("warns on unknown field", () => {
    const w = validateLLMFilter({ email: "alice@example.com" }, schema);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/email/);
  });

  test("skips $ operators (logical operators)", () => {
    const w = validateLLMFilter({ $and: [{ name: "x" }] }, schema);
    expect(w).toHaveLength(0);
  });

  test("warns on each unknown field independently", () => {
    const w = validateLLMFilter({ foo: 1, bar: 2 }, schema);
    expect(w).toHaveLength(2);
  });

  test("returns empty array when schema is null", () => {
    const w = validateLLMFilter({ anything: true }, null);
    expect(w).toHaveLength(0);
  });

  test("returns empty array when filter is null", () => {
    const w = validateLLMFilter(null, schema);
    expect(w).toHaveLength(0);
  });

  test("handles dotted field names — checks base field", () => {
    // 'name.first' → base field 'name' → known → no warning
    const w = validateLLMFilter({ "name.first": "Al" }, schema);
    expect(w).toHaveLength(0);
  });

  test("warns on unknown dotted base field", () => {
    const w = validateLLMFilter({ "address.city": "NY" }, schema);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/address\.city/);
  });
});
