import { describe, test, expect, beforeEach } from "vitest";
import IndexEngine from "../../src/engine/indexes.js";

describe("IndexEngine", () => {
  let engine;
  const docs = [
    { _id: "1", role: "admin", email: "a@test.com" },
    { _id: "2", role: "user",  email: "b@test.com" },
    { _id: "3", role: "admin", email: "c@test.com" },
  ];

  beforeEach(() => {
    engine = new IndexEngine(["role"], ["email"]);
    engine.buildFromData(docs);
  });

  test("lookup returns array of matching docs", () => {
    const admins = engine.lookup("role", "admin");
    expect(admins).toHaveLength(2);
    expect(admins.map(d => d._id).sort()).toEqual(["1", "3"]);
  });

  test("lookup returns empty array when no match", () => {
    expect(engine.lookup("role", "guest")).toEqual([]);
  });

  test("lookup returns null for non-indexed field", () => {
    expect(engine.lookup("name", "Alice")).toBeNull();
  });

  test("isUniqueTaken returns true for existing unique value", () => {
    expect(engine.isUniqueTaken("email", "a@test.com")).toBe(true);
  });

  test("isUniqueTaken returns false for non-existent value", () => {
    expect(engine.isUniqueTaken("email", "new@test.com")).toBe(false);
  });

  test("add() indexes a new document", () => {
    const newDoc = { _id: "4", role: "guest", email: "d@test.com" };
    engine.add(newDoc);
    expect(engine.lookup("role", "guest")).toHaveLength(1);
    expect(engine.isUniqueTaken("email", "d@test.com")).toBe(true);
  });

  test("add() throws on unique constraint violation", () => {
    expect(() => engine.add({ _id: "5", role: "admin", email: "a@test.com" })).toThrow(/Unique constraint/);
  });

  test("remove() removes document from indexes", () => {
    engine.remove(docs[0]);
    expect(engine.lookup("role", "admin")).toHaveLength(1);
    expect(engine.isUniqueTaken("email", "a@test.com")).toBe(false);
  });

  test("update() moves index entries", () => {
    const oldDoc = docs[1]; // role: user, email: b@test.com
    const newDoc = { ...oldDoc, role: "admin", email: "b@test.com" };
    engine.update(oldDoc, newDoc);
    expect(engine.lookup("role", "user")).toHaveLength(0);
    expect(engine.lookup("role", "admin")).toHaveLength(3);
  });

  test("update() throws on unique conflict with another doc", () => {
    const oldDoc = docs[1];
    const newDoc = { ...oldDoc, email: "a@test.com" }; // conflicts with docs[0]
    expect(() => engine.update(oldDoc, newDoc)).toThrow(/Unique constraint/);
  });

  test("update() allows updating a field to its own current value (self-update)", () => {
    const oldDoc = docs[0];
    const newDoc = { ...oldDoc, role: "superadmin" };
    expect(() => engine.update(oldDoc, newDoc)).not.toThrow();
    expect(engine.isUniqueTaken("email", "a@test.com")).toBe(true);
  });

  test("update() self-update via shallow copy does not throw (simulates collection.js mutation path)", () => {
    // collection.js does: const oldDoc = { ...item }; applyUpdate(item); update(oldDoc, item)
    // oldDoc is a COPY  -  not the same reference as what is stored in the index.
    // This must not throw even though oldDoc !== the indexed doc by reference.
    const liveDoc = docs[0]; // reference held by the index
    const oldDocCopy = { ...liveDoc }; // shallow copy, as collection.js creates
    liveDoc.role = "superadmin"; // simulate applyUpdate mutating in place
    expect(() => engine.update(oldDocCopy, liveDoc)).not.toThrow();
    expect(engine.isUniqueTaken("email", "a@test.com")).toBe(true);
  });

  test("indexedFields returns union of all indexed fields", () => {
    const fields = engine.indexedFields;
    expect(fields.has("role")).toBe(true);
    expect(fields.has("email")).toBe(true);
  });

  test("buildFromData resets and rebuilds", () => {
    const newData = [{ _id: "x", role: "mod", email: "x@test.com" }];
    engine.buildFromData(newData);
    expect(engine.lookup("role", "admin")).toHaveLength(0);
    expect(engine.lookup("role", "mod")).toHaveLength(1);
  });
});
