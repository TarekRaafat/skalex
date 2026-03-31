import { describe, test, expect } from "vitest";
import { parseSchema, validateDoc, inferSchema, stripInvalidFields } from "../../src/engine/validator.js";

describe("parseSchema", () => {
  test("parses string shorthand", () => {
    const { fields } = parseSchema({ name: "string", age: "number" });
    expect(fields.get("name")).toMatchObject({ type: "string", required: false, unique: false });
    expect(fields.get("age")).toMatchObject({ type: "number" });
  });

  test("parses object definition", () => {
    const { fields, uniqueFields } = parseSchema({
      email: { type: "string", required: true, unique: true },
    });
    expect(fields.get("email")).toMatchObject({ type: "string", required: true, unique: true });
    expect(uniqueFields).toContain("email");
  });

  test("parses enum", () => {
    const { fields } = parseSchema({ role: { type: "string", enum: ["admin", "user"] } });
    expect(fields.get("role").enum).toEqual(["admin", "user"]);
  });

  test("throws on unknown type", () => {
    expect(() => parseSchema({ x: "blah" })).toThrow(/Unknown schema type/);
  });

  test("throws on invalid definition", () => {
    expect(() => parseSchema({ x: 42 })).toThrow(/Invalid schema definition/);
  });
});

describe("validateDoc", () => {
  const { fields } = parseSchema({
    name: { type: "string", required: true },
    age:  { type: "number" },
    role: { type: "string", enum: ["admin", "user"] },
    active: "boolean",
    tags: "array",
    created: "date",
    meta: "any",
  });

  test("valid document returns no errors", () => {
    expect(validateDoc({ name: "Alice", age: 30 }, fields)).toEqual([]);
  });

  test("required field missing returns error", () => {
    const errs = validateDoc({ age: 30 }, fields);
    expect(errs).toContain("Field \"name\" is required");
  });

  test("wrong type returns error", () => {
    const errs = validateDoc({ name: "Alice", age: "thirty" }, fields);
    expect(errs.some(e => e.includes("\"age\""))).toBe(true);
  });

  test("enum violation returns error", () => {
    const errs = validateDoc({ name: "Alice", role: "superadmin" }, fields);
    expect(errs.some(e => e.includes("\"role\""))).toBe(true);
  });

  test("null/undefined optional field is not an error", () => {
    expect(validateDoc({ name: "Alice", age: null }, fields)).toEqual([]);
    expect(validateDoc({ name: "Alice" }, fields)).toEqual([]);
  });

  test("type \"any\" accepts any value", () => {
    expect(validateDoc({ name: "Alice", meta: { anything: true } }, fields)).toEqual([]);
  });

  test("array type validated correctly", () => {
    expect(validateDoc({ name: "Alice", tags: [] }, fields)).toEqual([]);
    const errs = validateDoc({ name: "Alice", tags: "not-array" }, fields);
    expect(errs.some(e => e.includes("\"tags\""))).toBe(true);
  });

  test("date type validated correctly", () => {
    expect(validateDoc({ name: "Alice", created: new Date() }, fields)).toEqual([]);
    const errs = validateDoc({ name: "Alice", created: "yesterday" }, fields);
    expect(errs.some(e => e.includes("\"created\""))).toBe(true);
  });
});

describe("validateDoc — strict mode", () => {
  const { fields } = parseSchema({ name: "string", age: "number" });

  test("no errors for a valid document containing only schema fields", () => {
    expect(validateDoc({ name: "Alice", age: 30 }, fields, true)).toEqual([]);
  });

  test("returns an error for an unknown field in strict mode", () => {
    const errs = validateDoc({ name: "Alice", extra: "data" }, fields, true);
    expect(errs.some(e => e.includes("Unknown field") && e.includes('"extra"'))).toBe(true);
  });

  test("reports multiple unknown fields", () => {
    const errs = validateDoc({ name: "Alice", a: 1, b: 2 }, fields, true);
    expect(errs.filter(e => e.includes("Unknown field"))).toHaveLength(2);
  });

  test("_-prefixed fields are permitted in strict mode", () => {
    const errs = validateDoc({ name: "Alice", _id: "123", _vector: [] }, fields, true);
    expect(errs).toEqual([]);
  });

  test("strict: false (default) allows unknown fields", () => {
    expect(validateDoc({ name: "Alice", extra: "data" }, fields, false)).toEqual([]);
    expect(validateDoc({ name: "Alice", extra: "data" }, fields)).toEqual([]);
  });

  test("strict mode accumulates both type errors and unknown-field errors", () => {
    const errs = validateDoc({ name: 42, extra: "data" }, fields, true);
    expect(errs.some(e => e.includes('"name"'))).toBe(true);
    expect(errs.some(e => e.includes("Unknown field"))).toBe(true);
  });
});

describe("stripInvalidFields", () => {
  const { fields } = parseSchema({
    name: "string",
    age:  "number",
    role: { type: "string", enum: ["admin", "user"] },
  });

  test("keeps fields that pass type and enum checks", () => {
    const out = stripInvalidFields({ name: "Alice", age: 30 }, fields);
    expect(out.name).toBe("Alice");
    expect(out.age).toBe(30);
  });

  test("removes fields not declared in the schema", () => {
    const out = stripInvalidFields({ name: "Alice", undeclared: "x" }, fields);
    expect(out.undeclared).toBeUndefined();
  });

  test("removes fields with wrong type", () => {
    const out = stripInvalidFields({ name: "Alice", age: "thirty" }, fields);
    expect(out.age).toBeUndefined();
  });

  test("removes fields that violate enum", () => {
    const out = stripInvalidFields({ name: "Alice", role: "superadmin" }, fields);
    expect(out.role).toBeUndefined();
  });

  test("preserves _-prefixed system fields unconditionally", () => {
    const out = stripInvalidFields({ name: "Alice", _id: "abc", _vector: [1, 2] }, fields);
    expect(out._id).toBe("abc");
    expect(out._vector).toEqual([1, 2]);
  });

  test("does not mutate the original document", () => {
    const doc = { name: "Alice", extra: "bad" };
    stripInvalidFields(doc, fields);
    expect(doc.extra).toBe("bad");
  });

  test("returns empty object (minus system fields) when nothing valid remains", () => {
    const out = stripInvalidFields({ undeclared: "x" }, fields);
    expect(Object.keys(out)).toHaveLength(0);
  });
});

describe("inferSchema", () => {
  test("infers types from a sample document", () => {
    const schema = inferSchema({ name: "Alice", age: 30, active: true, tags: [], created: new Date() });
    expect(schema.name).toBe("string");
    expect(schema.age).toBe("number");
    expect(schema.active).toBe("boolean");
    expect(schema.tags).toBe("array");
    expect(schema.created).toBe("date");
  });

  test("skips internal _ fields", () => {
    const schema = inferSchema({ _id: "123", name: "Alice" });
    expect(schema._id).toBeUndefined();
    expect(schema.name).toBe("string");
  });
});
