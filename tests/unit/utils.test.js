import { describe, test, expect } from "vitest";
import { resolveDotPath } from "../../src/engine/utils.js";

describe("resolveDotPath", () => {
  const doc = { name: "Alice", address: { city: "Cairo", country: { code: "EG" } } };

  test("resolves a top-level field", () => {
    expect(resolveDotPath(doc, "name")).toBe("Alice");
  });

  test("resolves a single-level dot-notation path", () => {
    expect(resolveDotPath(doc, "address.city")).toBe("Cairo");
  });

  test("resolves a two-level dot-notation path", () => {
    expect(resolveDotPath(doc, "address.country.code")).toBe("EG");
  });

  test("returns undefined for a missing top-level field", () => {
    expect(resolveDotPath(doc, "missing")).toBeUndefined();
  });

  test("returns undefined for a missing nested field without throwing", () => {
    expect(resolveDotPath(doc, "address.zip")).toBeUndefined();
  });

  test("returns undefined when an intermediate segment is null", () => {
    expect(resolveDotPath({ a: null }, "a.b")).toBeUndefined();
  });

  test("returns undefined when an intermediate segment is undefined", () => {
    expect(resolveDotPath({}, "a.b.c")).toBeUndefined();
  });
});
