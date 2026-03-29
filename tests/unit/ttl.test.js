import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { parseTtl, computeExpiry, sweep } from "../../src/ttl.js";

describe("parseTtl", () => {
  test("number → seconds to ms", () => {
    expect(parseTtl(60)).toBe(60_000);
    expect(parseTtl(0)).toBe(0);
  });

  test("ms suffix", () => {
    expect(parseTtl("500ms")).toBe(500);
  });

  test("s suffix", () => {
    expect(parseTtl("30s")).toBe(30_000);
  });

  test("m suffix", () => {
    expect(parseTtl("30m")).toBe(1_800_000);
  });

  test("h suffix", () => {
    expect(parseTtl("24h")).toBe(86_400_000);
  });

  test("d suffix", () => {
    expect(parseTtl("7d")).toBe(604_800_000);
  });

  test("decimal values", () => {
    expect(parseTtl("0.5h")).toBe(1_800_000);
  });

  test("invalid format throws", () => {
    expect(() => parseTtl("5years")).toThrow(/Invalid TTL format/);
    expect(() => parseTtl("abc")).toThrow();
  });

  test("non-string non-number throws", () => {
    expect(() => parseTtl(null)).toThrow(/Invalid TTL value/);
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
});
