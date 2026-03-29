import { describe, test, expect } from "vitest";
import { matchesFilter, presortFilter } from "../../src/query.js";

describe("matchesFilter", () => {
  const doc = { name: "Alice", age: 30, role: "admin", tags: ["a", "b"], address: { city: "Cairo" } };

  test("empty filter matches everything", () => {
    expect(matchesFilter(doc, {})).toBe(true);
  });

  test("function filter", () => {
    expect(matchesFilter(doc, d => d.age > 25)).toBe(true);
    expect(matchesFilter(doc, d => d.age > 35)).toBe(false);
  });

  test("exact match", () => {
    expect(matchesFilter(doc, { name: "Alice" })).toBe(true);
    expect(matchesFilter(doc, { name: "Bob" })).toBe(false);
  });

  test("multi-condition AND", () => {
    expect(matchesFilter(doc, { role: "admin", age: 30 })).toBe(true);
    expect(matchesFilter(doc, { role: "admin", age: 25 })).toBe(false);
  });

  test("dot-notation nested field", () => {
    expect(matchesFilter(doc, { "address.city": "Cairo" })).toBe(true);
    expect(matchesFilter(doc, { "address.city": "London" })).toBe(false);
  });

  test("missing nested field returns false without throwing", () => {
    expect(matchesFilter({ name: "X" }, { "address.city": "Cairo" })).toBe(false);
  });

  test("$eq", () => {
    expect(matchesFilter(doc, { age: { $eq: 30 } })).toBe(true);
    expect(matchesFilter(doc, { age: { $eq: 99 } })).toBe(false);
  });

  test("$ne", () => {
    expect(matchesFilter(doc, { age: { $ne: 99 } })).toBe(true);
    expect(matchesFilter(doc, { age: { $ne: 30 } })).toBe(false);
  });

  test("$gt / $lt", () => {
    expect(matchesFilter(doc, { age: { $gt: 25 } })).toBe(true);
    expect(matchesFilter(doc, { age: { $gt: 35 } })).toBe(false);
    expect(matchesFilter(doc, { age: { $lt: 35 } })).toBe(true);
    expect(matchesFilter(doc, { age: { $lt: 25 } })).toBe(false);
  });

  test("$gte / $lte", () => {
    expect(matchesFilter(doc, { age: { $gte: 30 } })).toBe(true);
    expect(matchesFilter(doc, { age: { $lte: 30 } })).toBe(true);
    expect(matchesFilter(doc, { age: { $gte: 31 } })).toBe(false);
  });

  test("$in", () => {
    expect(matchesFilter(doc, { role: { $in: ["admin", "user"] } })).toBe(true);
    expect(matchesFilter(doc, { role: { $in: ["user", "guest"] } })).toBe(false);
  });

  test("$nin", () => {
    expect(matchesFilter(doc, { role: { $nin: ["user", "guest"] } })).toBe(true);
    expect(matchesFilter(doc, { role: { $nin: ["admin", "guest"] } })).toBe(false);
  });

  test("$regex", () => {
    expect(matchesFilter(doc, { name: { $regex: /^Al/ } })).toBe(true);
    expect(matchesFilter(doc, { name: { $regex: /^Bo/ } })).toBe(false);
  });

  test("$fn", () => {
    expect(matchesFilter(doc, { age: { $fn: v => v > 20 } })).toBe(true);
    expect(matchesFilter(doc, { age: { $fn: v => v > 50 } })).toBe(false);
  });

  test("RegExp as direct value", () => {
    expect(matchesFilter(doc, { name: /alice/i })).toBe(true);
    expect(matchesFilter(doc, { name: /^bob/i })).toBe(false);
  });

  test("falsy value 0 matches correctly", () => {
    expect(matchesFilter({ score: 0 }, { score: 0 })).toBe(true);
    expect(matchesFilter({ score: 0 }, { score: 1 })).toBe(false);
  });
});

describe("presortFilter", () => {
  test("indexed fields come first", () => {
    const filter = { role: "admin", name: /alice/i, age: { $gt: 20 } };
    const sorted = presortFilter(filter, new Set(["role"]));
    const keys = Object.keys(sorted);
    expect(keys[0]).toBe("role");
    expect(keys[keys.length - 1]).toBe("name"); // regex last
  });

  test("equality before range", () => {
    const filter = { age: { $gt: 20 }, name: "Alice" };
    const sorted = presortFilter(filter, new Set());
    expect(Object.keys(sorted)[0]).toBe("name");
  });

  test("non-object filter returned unchanged", () => {
    expect(presortFilter(null)).toBe(null);
    expect(presortFilter("str")).toBe("str");
  });
});
