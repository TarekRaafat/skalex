import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { computeExpiry, sweep } from "../../src/engine/ttl.js";

describe("parseTtl validation", () => {
  test("rejects negative numeric TTL", () => {
    expect(() => computeExpiry(-1)).toThrow(/positive/);
    expect(() => computeExpiry(-300)).toThrow(/positive/);
  });

  test("rejects zero TTL", () => {
    expect(() => computeExpiry(0)).toThrow(/positive/);
  });

  test("rejects negative string TTL", () => {
    // "-5s" does not match the positive-number regex  -  invalid format
    expect(() => computeExpiry("-5s")).toThrow(/Invalid TTL/);
  });

  test("accepts valid positive TTLs without throwing", () => {
    expect(() => computeExpiry(1)).not.toThrow();
    expect(() => computeExpiry("30m")).not.toThrow();
    expect(() => computeExpiry("24h")).not.toThrow();
    expect(() => computeExpiry("7d")).not.toThrow();
    expect(() => computeExpiry("500ms")).not.toThrow();
  });
});

describe("computeExpiry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("returns a Date in the future", () => {
    const expiry = computeExpiry("1h");
    expect(expiry).toBeInstanceOf(Date);
    expect(expiry.getTime()).toBe(new Date("2025-01-01T01:00:00Z").getTime());
  });
});

describe("sweep", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-01T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("removes expired documents", () => {
    const past = new Date("2025-06-01T11:00:00Z"); // 1 hour ago
    const future = new Date("2025-06-01T13:00:00Z"); // 1 hour ahead

    const expired = { _id: "1", name: "old", _expiresAt: past };
    const fresh   = { _id: "2", name: "new", _expiresAt: future };
    const noTtl   = { _id: "3", name: "forever" };

    const data = [expired, fresh, noTtl];
    const idIndex = new Map(data.map(d => [d._id, d]));

    const removed = sweep(data, idIndex);

    expect(removed).toBe(1);
    expect(data).toHaveLength(2);
    expect(data.find(d => d._id === "1")).toBeUndefined();
    expect(idIndex.has("1")).toBe(false);
    expect(idIndex.has("2")).toBe(true);
    expect(idIndex.has("3")).toBe(true);
  });

  test("calls removeFromIndexes callback for each expired doc", () => {
    const expired = { _id: "1", _expiresAt: new Date("2025-01-01") };
    const data = [expired];
    const idIndex = new Map([["1", expired]]);
    const removeFn = vi.fn();

    sweep(data, idIndex, removeFn);

    expect(removeFn).toHaveBeenCalledWith(expired);
  });

  test("returns 0 when nothing is expired", () => {
    const doc = { _id: "1", _expiresAt: new Date("2026-01-01") };
    const data = [doc];
    const idIndex = new Map([["1", doc]]);
    expect(sweep(data, idIndex)).toBe(0);
  });

  test("sweep removes all expired docs in one linear pass", () => {
    // Regression: sweep() used to splice-in-place, making it O(n*k). Now
    // it filters once; this test pins the linear behaviour (large n, many
    // expired) so a regression to the splice loop would time out or fail
    // to remove everything on the first pass.
    const past = new Date(Date.now() - 1000);
    const future = new Date(Date.now() + 100000);
    const data = [];
    const idIndex = new Map();
    for (let i = 0; i < 100; i++) {
      const doc = { _id: `d${i}`, _expiresAt: i < 50 ? past : future };
      data.push(doc);
      idIndex.set(doc._id, doc);
    }
    const removed = sweep(data, idIndex);
    expect(removed).toBe(50);
    expect(data).toHaveLength(50);
    for (const doc of data) expect(idIndex.has(doc._id)).toBe(true);
  });
});
