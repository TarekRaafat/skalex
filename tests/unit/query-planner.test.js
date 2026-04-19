/**
 * Unit tests for query-planner.js - findRaw, findAllRaw, getCandidates, findIndex.
 */
import { describe, test, expect, vi } from "vitest";
import { findRaw, findAllRaw, getCandidates, findIndex } from "../../src/engine/query-planner.js";

/** Default isVisible: all docs visible, respects includeDeleted for soft-deleted docs. */
const alwaysVisible = () => true;

/** isVisible that hides docs with _deletedAt unless includeDeleted is true. */
const softDeleteVisible = (doc, includeDeleted) => includeDeleted || !doc._deletedAt;

function makeData(...docs) {
  const data = docs;
  const idIndex = new Map(docs.map(d => [d._id, d]));
  return { data, idIndex };
}

// ─── findRaw ─────────────────────────────────────────────────────────────────

describe("findRaw", () => {
  test("null filter returns first visible doc", () => {
    const { data, idIndex } = makeData(
      { _id: "1", v: 1 },
      { _id: "2", v: 2 },
    );
    const result = findRaw(null, data, idIndex, null, alwaysVisible);
    expect(result._id).toBe("1");
  });

  test("undefined filter returns first visible doc", () => {
    const { data, idIndex } = makeData(
      { _id: "1", v: 1 },
      { _id: "2", v: 2 },
    );
    const result = findRaw(undefined, data, idIndex, null, alwaysVisible);
    expect(result._id).toBe("1");
  });

  test("_id filter uses index lookup", () => {
    const { data, idIndex } = makeData(
      { _id: "a", v: 1 },
      { _id: "b", v: 2 },
      { _id: "c", v: 3 },
    );
    const result = findRaw({ _id: "b" }, data, idIndex, null, alwaysVisible);
    expect(result._id).toBe("b");
    expect(result.v).toBe(2);
  });

  test("_id + extra fields checks both", () => {
    const { data, idIndex } = makeData(
      { _id: "a", status: "active", v: 1 },
      { _id: "b", status: "inactive", v: 2 },
    );
    // Match: _id exists AND status matches
    const match = findRaw({ _id: "a", status: "active" }, data, idIndex, null, alwaysVisible);
    expect(match._id).toBe("a");
    // No match: _id exists but status does not match
    const noMatch = findRaw({ _id: "a", status: "inactive" }, data, idIndex, null, alwaysVisible);
    expect(noMatch).toBeNull();
  });

  test("function filter iterates and applies", () => {
    const { data, idIndex } = makeData(
      { _id: "1", v: 10 },
      { _id: "2", v: 20 },
      { _id: "3", v: 30 },
    );
    const result = findRaw(d => d.v > 15, data, idIndex, null, alwaysVisible);
    expect(result._id).toBe("2");
  });

  test("respects isVisible callback (soft-delete filtering)", () => {
    const { data, idIndex } = makeData(
      { _id: "1", v: 1, _deletedAt: new Date() },
      { _id: "2", v: 2 },
    );
    const result = findRaw(null, data, idIndex, null, softDeleteVisible);
    expect(result._id).toBe("2");
  });

  test("empty data returns null", () => {
    const result = findRaw(null, [], new Map(), null, alwaysVisible);
    expect(result).toBeNull();
  });

  test("_id filter returns null for non-existent id", () => {
    const { data, idIndex } = makeData({ _id: "a", v: 1 });
    const result = findRaw({ _id: "missing" }, data, idIndex, null, alwaysVisible);
    expect(result).toBeNull();
  });

  test("_id filter returns null when doc exists but is not visible", () => {
    const { data, idIndex } = makeData(
      { _id: "1", v: 1, _deletedAt: new Date() },
    );
    const result = findRaw({ _id: "1" }, data, idIndex, null, softDeleteVisible);
    expect(result).toBeNull();
  });
});

// ─── findAllRaw ──────────────────────────────────────────────────────────────

describe("findAllRaw", () => {
  test("_id filter returns single-element array or empty", () => {
    const { data, idIndex } = makeData(
      { _id: "a", v: 1 },
      { _id: "b", v: 2 },
    );
    const found = findAllRaw({ _id: "a" }, data, idIndex, null, alwaysVisible);
    expect(found).toHaveLength(1);
    expect(found[0]._id).toBe("a");

    const empty = findAllRaw({ _id: "missing" }, data, idIndex, null, alwaysVisible);
    expect(empty).toHaveLength(0);
  });

  test("function filter returns all matches", () => {
    const { data, idIndex } = makeData(
      { _id: "1", v: 10 },
      { _id: "2", v: 20 },
      { _id: "3", v: 30 },
    );
    const result = findAllRaw(d => d.v >= 20, data, idIndex, null, alwaysVisible);
    expect(result).toHaveLength(2);
    expect(result.map(d => d._id)).toEqual(["2", "3"]);
  });

  test("includeDeleted returns soft-deleted docs", () => {
    const { data, idIndex } = makeData(
      { _id: "1", v: 1, _deletedAt: new Date() },
      { _id: "2", v: 2 },
    );
    const without = findAllRaw({}, data, idIndex, null, softDeleteVisible);
    expect(without).toHaveLength(1);

    const withDeleted = findAllRaw({}, data, idIndex, null, softDeleteVisible, { includeDeleted: true });
    expect(withDeleted).toHaveLength(2);
  });
});

// ─── getCandidates ───────────────────────────────────────────────────────────

describe("getCandidates", () => {
  test("with no fieldIndex returns full data", () => {
    const data = [{ _id: "1" }, { _id: "2" }];
    const result = getCandidates({ name: "Alice" }, data, null);
    expect(result).toBe(data);
  });

  test("with fieldIndex tries single-field lookup", () => {
    const d1 = { _id: "1", name: "Alice" };
    const d2 = { _id: "2", name: "Bob" };
    const data = [d1, d2];
    const fieldIndex = {
      _compoundIndexes: new Map(),
      _lookupIterable: vi.fn((key, val) => {
        if (key === "name" && val === "Alice") return [d1];
        return null;
      }),
    };
    const result = [...getCandidates({ name: "Alice" }, data, fieldIndex)];
    expect(result).toEqual([d1]);
    expect(fieldIndex._lookupIterable).toHaveBeenCalledWith("name", "Alice");
  });

  test("skips logical operator keys ($or, $and, $not) in index lookup", () => {
    const data = [{ _id: "1" }];
    const fieldIndex = {
      _compoundIndexes: new Map(),
      _lookupIterable: vi.fn(() => null),
    };
    getCandidates({ $or: [{ a: 1 }], name: "x" }, data, fieldIndex);
    // Should NOT try to look up $or
    const calls = fieldIndex._lookupIterable.mock.calls;
    expect(calls.every(([key]) => key !== "$or")).toBe(true);
  });
});

// ─── findIndex ───────────────────────────────────────────────────────────────

describe("findIndex", () => {
  test("returns correct position", () => {
    const data = [
      { _id: "1", name: "Alice" },
      { _id: "2", name: "Bob" },
      { _id: "3", name: "Carol" },
    ];
    expect(findIndex({ name: "Bob" }, data)).toBe(1);
  });

  test("returns -1 when not found", () => {
    const data = [
      { _id: "1", name: "Alice" },
    ];
    expect(findIndex({ name: "Zara" }, data)).toBe(-1);
  });

  test("returns -1 on empty data", () => {
    expect(findIndex({ name: "x" }, [])).toBe(-1);
  });
});
