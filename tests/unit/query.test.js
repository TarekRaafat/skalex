import { describe, test, expect } from "vitest";
import { matchesFilter, presortFilter } from "../../src/engine/query.js";

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

  test("$regex with RegExp instance", () => {
    expect(matchesFilter(doc, { name: { $regex: /^Al/ } })).toBe(true);
    expect(matchesFilter(doc, { name: { $regex: /^Bo/ } })).toBe(false);
  });

  test("$regex with string (LLM-produced)", () => {
    expect(matchesFilter(doc, { name: { $regex: "^Al" } })).toBe(true);
    expect(matchesFilter(doc, { name: { $regex: "^Bo" } })).toBe(false);
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

describe("logical operators", () => {
  const docs = [
    { name: "Alice", age: 30, role: "admin" },
    { name: "Bob", age: 25, role: "user" },
    { name: "Carol", age: 35, role: "admin" },
    { name: "Dave", age: 20, role: "user" },
  ];

  test("$or matches if any sub-filter matches", () => {
    const filter = { $or: [{ name: "Alice" }, { name: "Bob" }] };
    const matches = docs.filter(d => matchesFilter(d, filter));
    expect(matches).toHaveLength(2);
    expect(matches.map(d => d.name).sort()).toEqual(["Alice", "Bob"]);
  });

  test("$or returns false when no sub-filter matches", () => {
    expect(matchesFilter(docs[0], { $or: [{ name: "X" }, { name: "Y" }] })).toBe(false);
  });

  test("$and matches only if all sub-filters match", () => {
    const filter = { $and: [{ role: "admin" }, { age: { $gte: 35 } }] };
    const matches = docs.filter(d => matchesFilter(d, filter));
    expect(matches).toHaveLength(1);
    expect(matches[0].name).toBe("Carol");
  });

  test("$not negates a filter", () => {
    const filter = { $not: { role: "admin" } };
    const matches = docs.filter(d => matchesFilter(d, filter));
    expect(matches).toHaveLength(2);
    expect(matches.every(d => d.role === "user")).toBe(true);
  });

  test("$or combined with field-level conditions", () => {
    const filter = { role: "admin", $or: [{ age: 30 }, { age: 35 }] };
    const matches = docs.filter(d => matchesFilter(d, filter));
    expect(matches).toHaveLength(2);
  });

  test("$not combined with $or", () => {
    const filter = { $not: { $or: [{ name: "Alice" }, { name: "Bob" }] } };
    const matches = docs.filter(d => matchesFilter(d, filter));
    expect(matches).toHaveLength(2);
    expect(matches.map(d => d.name).sort()).toEqual(["Carol", "Dave"]);
  });

  test("nested $and inside $or", () => {
    const filter = {
      $or: [
        { $and: [{ role: "admin" }, { age: { $lt: 32 } }] },
        { name: "Dave" },
      ]
    };
    const matches = docs.filter(d => matchesFilter(d, filter));
    expect(matches).toHaveLength(2);
    expect(matches.map(d => d.name).sort()).toEqual(["Alice", "Dave"]);
  });

  test("$or with non-array throws QueryError", () => {
    expect(() => matchesFilter(docs[0], { $or: "invalid" })).toThrow("$or must be an array");
  });

  test("$and with non-array throws QueryError", () => {
    expect(() => matchesFilter(docs[0], { $and: "invalid" })).toThrow("$and must be an array");
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
