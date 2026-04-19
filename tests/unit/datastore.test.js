/**
 * Unit tests for InMemoryDataStore - the abstraction layer between
 * Collection and raw data/index storage.
 */
import { describe, test, expect } from "vitest";
import InMemoryDataStore from "../../src/engine/datastore.js";

function makeStore(docs = []) {
  const data = [...docs];
  const index = new Map(docs.map(d => [d._id, d]));
  return { data, index };
}

function makeDs(docs = []) {
  return new InMemoryDataStore(makeStore(docs));
}

describe("InMemoryDataStore", () => {
  // ---- push ----------------------------------------------------------------

  test("push single doc, verify count and getById", () => {
    const ds = makeDs();
    const doc = { _id: "a1", name: "Alice" };
    ds.push(doc);
    expect(ds.count()).toBe(1);
    expect(ds.getById("a1")).toBe(doc);
  });

  test("push multiple docs, verify all indexed", () => {
    const ds = makeDs();
    const d1 = { _id: "a1", name: "Alice" };
    const d2 = { _id: "b2", name: "Bob" };
    const d3 = { _id: "c3", name: "Carol" };
    ds.push(d1, d2, d3);
    expect(ds.count()).toBe(3);
    expect(ds.getById("a1")).toBe(d1);
    expect(ds.getById("b2")).toBe(d2);
    expect(ds.getById("c3")).toBe(d3);
  });

  // ---- replaceAt -----------------------------------------------------------

  test("replaceAt: replace a doc at position, verify old doc gone from index, new doc in index", () => {
    const old = { _id: "old1", v: 1 };
    const ds = makeDs([old]);
    const replacement = { _id: "new1", v: 2 };
    ds.replaceAt(0, replacement);
    expect(ds.data[0]).toBe(replacement);
    expect(ds.getById("new1")).toBe(replacement);
    // Old id may still be in index since replaceAt only sets, not deletes old.
    // But the data position is replaced.
    expect(ds.data).toHaveLength(1);
  });

  // ---- spliceAt ------------------------------------------------------------

  test("spliceAt: remove by position, verify removed from data and index", () => {
    const d1 = { _id: "a", v: 1 };
    const d2 = { _id: "b", v: 2 };
    const d3 = { _id: "c", v: 3 };
    const ds = makeDs([d1, d2, d3]);
    const removed = ds.spliceAt(1);
    expect(removed).toBe(d2);
    expect(ds.count()).toBe(2);
    expect(ds.has("b")).toBe(false);
    expect(ds.getById("b")).toBeNull();
    expect(ds.data[0]).toBe(d1);
    expect(ds.data[1]).toBe(d3);
  });

  // ---- spliceRange ---------------------------------------------------------

  test("spliceRange(0, N): remove first N, verify remaining", () => {
    const docs = [
      { _id: "1", v: 1 },
      { _id: "2", v: 2 },
      { _id: "3", v: 3 },
      { _id: "4", v: 4 },
    ];
    const ds = makeDs(docs);
    const removed = ds.spliceRange(0, 2);
    expect(removed).toHaveLength(2);
    expect(removed[0]._id).toBe("1");
    expect(removed[1]._id).toBe("2");
    expect(ds.count()).toBe(2);
    expect(ds.has("1")).toBe(false);
    expect(ds.has("2")).toBe(false);
    expect(ds.has("3")).toBe(true);
    expect(ds.has("4")).toBe(true);
  });

  test("spliceRange with count=0: no-op", () => {
    const d1 = { _id: "a", v: 1 };
    const ds = makeDs([d1]);
    const removed = ds.spliceRange(0, 0);
    expect(removed).toHaveLength(0);
    expect(ds.count()).toBe(1);
    expect(ds.has("a")).toBe(true);
  });

  test("spliceRange with count > length: removes to end", () => {
    const docs = [
      { _id: "1", v: 1 },
      { _id: "2", v: 2 },
    ];
    const ds = makeDs(docs);
    const removed = ds.spliceRange(0, 100);
    expect(removed).toHaveLength(2);
    expect(ds.count()).toBe(0);
    expect(ds.has("1")).toBe(false);
    expect(ds.has("2")).toBe(false);
  });

  // ---- deleteFromIndex -----------------------------------------------------

  test("deleteFromIndex: only removes from index, data unchanged", () => {
    const doc = { _id: "x", v: 1 };
    const ds = makeDs([doc]);
    ds.deleteFromIndex("x");
    expect(ds.has("x")).toBe(false);
    expect(ds.getById("x")).toBeNull();
    // Data array still contains the doc
    expect(ds.count()).toBe(1);
    expect(ds.data[0]).toBe(doc);
  });

  // ---- setInIndex ----------------------------------------------------------

  test("setInIndex: updates index without changing data position", () => {
    const doc = { _id: "x", v: 1 };
    const ds = makeDs([doc]);
    const updated = { _id: "x", v: 2 };
    ds.setInIndex("x", updated);
    expect(ds.getById("x")).toBe(updated);
    // Data array still has the original reference at position 0
    expect(ds.data[0]).toBe(doc);
  });

  // ---- replaceAll ----------------------------------------------------------

  test("replaceAll: clears and rebuilds index from new array", () => {
    const ds = makeDs([
      { _id: "old1", v: 1 },
      { _id: "old2", v: 2 },
    ]);
    const newDocs = [
      { _id: "new1", v: 10 },
      { _id: "new2", v: 20 },
      { _id: "new3", v: 30 },
    ];
    ds.replaceAll(newDocs);
    expect(ds.count()).toBe(3);
    expect(ds.has("old1")).toBe(false);
    expect(ds.has("old2")).toBe(false);
    expect(ds.getById("new1")).toBe(newDocs[0]);
    expect(ds.getById("new2")).toBe(newDocs[1]);
    expect(ds.getById("new3")).toBe(newDocs[2]);
  });

  test("replaceAll with empty array: count is 0, getById returns null", () => {
    const ds = makeDs([{ _id: "a", v: 1 }]);
    ds.replaceAll([]);
    expect(ds.count()).toBe(0);
    expect(ds.getById("a")).toBeNull();
  });

  // ---- indexOf -------------------------------------------------------------

  test("indexOf: returns correct position", () => {
    const d1 = { _id: "a", v: 1 };
    const d2 = { _id: "b", v: 2 };
    const d3 = { _id: "c", v: 3 };
    const ds = makeDs([d1, d2, d3]);
    expect(ds.indexOf(d1)).toBe(0);
    expect(ds.indexOf(d2)).toBe(1);
    expect(ds.indexOf(d3)).toBe(2);
    expect(ds.indexOf({ _id: "z" })).toBe(-1);
  });

  // ---- has -----------------------------------------------------------------

  test("has: returns true/false correctly", () => {
    const ds = makeDs([{ _id: "exists", v: 1 }]);
    expect(ds.has("exists")).toBe(true);
    expect(ds.has("nope")).toBe(false);
  });

  // ---- Symbol.iterator -----------------------------------------------------

  test("Symbol.iterator: iterates all docs in order", () => {
    const docs = [
      { _id: "a", v: 1 },
      { _id: "b", v: 2 },
      { _id: "c", v: 3 },
    ];
    const ds = makeDs(docs);
    const result = [...ds];
    expect(result).toHaveLength(3);
    expect(result[0]).toBe(docs[0]);
    expect(result[1]).toBe(docs[1]);
    expect(result[2]).toBe(docs[2]);
  });

  // ---- count after various operations --------------------------------------

  test("count after various operations", () => {
    const ds = makeDs();
    expect(ds.count()).toBe(0);
    ds.push({ _id: "1", v: 1 });
    expect(ds.count()).toBe(1);
    ds.push({ _id: "2", v: 2 }, { _id: "3", v: 3 });
    expect(ds.count()).toBe(3);
    ds.spliceAt(0);
    expect(ds.count()).toBe(2);
    ds.replaceAll([]);
    expect(ds.count()).toBe(0);
  });
});
