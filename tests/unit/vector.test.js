import { describe, test, expect } from "vitest";
import { cosineSimilarity, stripVector } from "../../src/engine/vector.js";

// ─── cosineSimilarity ────────────────────────────────────────────────────────

describe("cosineSimilarity", () => {
  test("identical vectors → 1.0", () => {
    const v = [0.5, 0.3, 0.8, 0.1];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0);
  });

  test("orthogonal vectors → 0.0", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0);
  });

  test("opposite vectors → -1.0", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0);
  });

  test("zero vector → 0 (not NaN)", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([0, 0, 0], [0, 0, 0])).toBe(0);
  });

  test("higher similarity for more aligned vectors", () => {
    const base = [1, 0, 0, 0];
    const close = [0.9, 0.1, 0, 0];
    const far   = [0.1, 0.9, 0, 0];
    expect(cosineSimilarity(base, close)).toBeGreaterThan(cosineSimilarity(base, far));
  });

  test("dimension mismatch throws", () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow("dimension mismatch");
  });

  test("symmetry: sim(a, b) === sim(b, a)", () => {
    const a = [0.2, 0.5, 0.9];
    const b = [0.8, 0.1, 0.3];
    expect(cosineSimilarity(a, b)).toBeCloseTo(cosineSimilarity(b, a));
  });

  test("normalised vectors → dot product equals cosine similarity", () => {
    // Unit vectors: magnitude = 1, so cosine = dot product
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0);

    const c = [1 / Math.sqrt(2), 1 / Math.sqrt(2), 0];
    expect(cosineSimilarity(a, c)).toBeCloseTo(1 / Math.sqrt(2));
  });
});

// ─── stripVector ─────────────────────────────────────────────────────────────

describe("stripVector", () => {
  test("removes _vector field", () => {
    const doc = { _id: "1", name: "Alice", _vector: [0.1, 0.2] };
    const result = stripVector(doc);
    expect(result._vector).toBeUndefined();
    expect(result.name).toBe("Alice");
  });

  test("returns a shallow copy — does not mutate original", () => {
    const doc = { _id: "1", _vector: [0.1, 0.2] };
    const result = stripVector(doc);
    expect(doc._vector).toBeDefined();       // original untouched
    expect(result).not.toBe(doc);            // different reference
  });

  test("doc without _vector passes through unchanged", () => {
    const doc = { _id: "1", name: "Bob" };
    const result = stripVector(doc);
    expect(result).toEqual({ _id: "1", name: "Bob" });
  });

  test("other internal fields (_id, _expiresAt) are preserved", () => {
    const exp = new Date();
    const doc = { _id: "x", _expiresAt: exp, _vector: [1, 2] };
    const result = stripVector(doc);
    expect(result._id).toBe("x");
    expect(result._expiresAt).toBe(exp);
    expect(result._vector).toBeUndefined();
  });
});
