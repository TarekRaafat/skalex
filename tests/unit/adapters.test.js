/**
 * Unit tests for the AI adapter factories in src/engine/adapters.js.
 */
import { describe, test, expect } from "vitest";
import { createLLMAdapter } from "../../src/engine/adapters.js";

describe("createLLMAdapter", () => {
  test("throws AdapterError on unknown provider", () => {
    expect(() => createLLMAdapter({ provider: "opanai", model: "gpt-4" }))
      .toThrowError(/Unknown LLM provider/);
  });

  test("returns null when no model is given (backwards-compat)", () => {
    expect(createLLMAdapter({ provider: "openai" })).toBe(null);
  });
});
