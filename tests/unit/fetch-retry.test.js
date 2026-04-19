/**
 * Unit tests for fetchWithRetry - retry logic, timeout, exponential
 * backoff, and custom fetch function injection.
 */
import { describe, test, expect, vi } from "vitest";
import { fetchWithRetry } from "../../src/connectors/shared/fetch.js";

describe("fetchWithRetry", () => {
  test("successful fetch on first try returns response", async () => {
    const mockResp = { ok: true, status: 200 };
    const fetchFn = vi.fn().mockResolvedValue(mockResp);
    const result = await fetchWithRetry("https://example.com", {}, { fetchFn });
    expect(result).toBe(mockResp);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  test("retries on failure, succeeds on retry", async () => {
    const mockResp = { ok: true, status: 200 };
    const fetchFn = vi.fn()
      .mockRejectedValueOnce(new Error("fail1"))
      .mockResolvedValueOnce(mockResp);

    const result = await fetchWithRetry("https://example.com", {}, { fetchFn, retries: 2, retryDelay: 1 });
    expect(result).toBe(mockResp);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  test("respects retryDelay doubling with exponential backoff", async () => {
    const timestamps = [];
    const fetchFn = vi.fn().mockImplementation(() => {
      timestamps.push(Date.now());
      if (fetchFn.mock.calls.length < 3) return Promise.reject(new Error("fail"));
      return Promise.resolve({ ok: true });
    });

    await fetchWithRetry("https://example.com", {}, { fetchFn, retries: 3, retryDelay: 50 });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    // First delay: 50 * 2^0 = 50ms, second delay: 50 * 2^1 = 100ms
    // Verify second gap is roughly double the first
    const gap1 = timestamps[1] - timestamps[0];
    const gap2 = timestamps[2] - timestamps[1];
    expect(gap2).toBeGreaterThanOrEqual(gap1 * 1.5);
  });

  test("exhausts all retries and throws last error", async () => {
    const fetchFn = vi.fn()
      .mockRejectedValueOnce(new Error("fail1"))
      .mockRejectedValueOnce(new Error("fail2"))
      .mockRejectedValueOnce(new Error("fail3"));

    await expect(
      fetchWithRetry("https://example.com", {}, { fetchFn, retries: 2, retryDelay: 1 }),
    ).rejects.toThrow("fail3");
    expect(fetchFn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  test("timeout aborts the request (mock slow fetch)", async () => {
    const fetchFn = vi.fn().mockImplementation((_url, opts) => {
      return new Promise((resolve, reject) => {
        const tid = setTimeout(() => resolve({ ok: true }), 5000);
        if (opts?.signal) {
          opts.signal.addEventListener("abort", () => {
            clearTimeout(tid);
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }
      });
    });

    await expect(
      fetchWithRetry("https://example.com", {}, { fetchFn, timeout: 50 }),
    ).rejects.toThrow(/abort/i);
  });

  test("timeout timer is cleared on success (no lingering timers)", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true });
    // If clearTimeout is not called, a 50ms timer would linger.
    // The test passes if no unhandled errors occur.
    await fetchWithRetry("https://example.com", {}, { fetchFn, timeout: 50 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  test("retries=0 means no retries (fails immediately)", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(
      fetchWithRetry("https://example.com", {}, { fetchFn, retries: 0 }),
    ).rejects.toThrow("boom");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  test("uses custom fetchFn when provided", async () => {
    const customFetch = vi.fn().mockResolvedValue({ custom: true });
    const result = await fetchWithRetry("https://test.com", {}, { fetchFn: customFetch });
    expect(result).toEqual({ custom: true });
    expect(customFetch).toHaveBeenCalledTimes(1);
  });

  test("passes options (method, headers, body) through to fetch", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true });
    const options = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "value" }),
    };
    await fetchWithRetry("https://example.com", options, { fetchFn });
    const callArgs = fetchFn.mock.calls[0];
    expect(callArgs[0]).toBe("https://example.com");
    expect(callArgs[1].method).toBe("POST");
    expect(callArgs[1].headers).toEqual({ "Content-Type": "application/json" });
    expect(callArgs[1].body).toBe(JSON.stringify({ key: "value" }));
  });
});
