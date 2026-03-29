import { describe, test, expect } from "vitest";
import { parseSchema, validateDoc, inferSchema } from "../../src/validator.js";

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
