/**
 * Unit tests for buildDoc - document construction with _id, timestamps,
 * TTL, embedding, versioning, and custom ID generators.
 */
import { describe, test, expect, vi } from "vitest";
import { buildDoc } from "../../src/engine/document-builder.js";
import { AdapterError } from "../../src/engine/errors.js";

describe("buildDoc", () => {
  test("builds doc with _id, createdAt, updatedAt", async () => {
    const doc = await buildDoc({ name: "Alice" });
    expect(doc._id).toBeDefined();
    expect(typeof doc._id).toBe("string");
    expect(doc.createdAt).toBeInstanceOf(Date);
    expect(doc.updatedAt).toBeInstanceOf(Date);
    expect(doc.name).toBe("Alice");
  });

  test("preserves user-supplied _id", async () => {
    const doc = await buildDoc({ _id: "custom-id", name: "Bob" });
    expect(doc._id).toBe("custom-id");
  });

  test("applies TTL via computeExpiry when ttl option set", async () => {
    const doc = await buildDoc({ name: "tmp" }, { ttl: "1h" });
    expect(doc._expiresAt).toBeInstanceOf(Date);
    expect(doc._expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  test("applies defaultTtl when no per-doc ttl", async () => {
    const doc = await buildDoc({ name: "tmp" }, { defaultTtl: "30m" });
    expect(doc._expiresAt).toBeInstanceOf(Date);
    expect(doc._expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  test("per-doc ttl overrides defaultTtl", async () => {
    const short = await buildDoc({ name: "a" }, { ttl: "1m", defaultTtl: "1h" });
    const long = await buildDoc({ name: "b" }, { defaultTtl: "1h" });
    // 1m expiry should be earlier than 1h expiry
    expect(short._expiresAt.getTime()).toBeLessThan(long._expiresAt.getTime());
  });

  test("calls embedFn when embed option is a field name", async () => {
    const embedFn = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);
    const doc = await buildDoc({ name: "Alice", bio: "Hello world" }, { embed: "bio", embedFn });
    expect(embedFn).toHaveBeenCalledWith("Hello world");
    expect(doc._vector).toEqual([0.1, 0.2, 0.3]);
  });

  test("calls embedFn when embed option is a function", async () => {
    const embedFn = vi.fn().mockResolvedValue([0.4, 0.5]);
    const extractText = (item) => `${item.first} ${item.last}`;
    const doc = await buildDoc(
      { first: "Alice", last: "Smith" },
      { embed: extractText, embedFn },
    );
    expect(embedFn).toHaveBeenCalledWith("Alice Smith");
    expect(doc._vector).toEqual([0.4, 0.5]);
  });

  test("throws AdapterError when embed is set but embedFn is null/undefined", async () => {
    await expect(
      buildDoc({ name: "x", bio: "hello" }, { embed: "bio", embedFn: null }),
    ).rejects.toThrow(AdapterError);

    await expect(
      buildDoc({ name: "x", bio: "hello" }, { embed: "bio", embedFn: undefined }),
    ).rejects.toThrow(AdapterError);

    await expect(
      buildDoc({ name: "x", bio: "hello" }, { embed: "bio" }),
    ).rejects.toThrow(/embedding/i);
  });

  test("sets _version = 1 when versioning is true", async () => {
    const doc = await buildDoc({ name: "v" }, { versioning: true });
    expect(doc._version).toBe(1);
  });

  test("does not set _version when versioning is false", async () => {
    const doc = await buildDoc({ name: "v" }, { versioning: false });
    expect(doc._version).toBeUndefined();
  });

  test("does not set _version when versioning is not provided", async () => {
    const doc = await buildDoc({ name: "v" });
    expect(doc._version).toBeUndefined();
  });

  test("uses custom idGenerator when provided", async () => {
    let counter = 0;
    const idGen = () => `custom-${++counter}`;
    const doc = await buildDoc({ name: "x" }, { idGenerator: idGen });
    expect(doc._id).toBe("custom-1");
  });
});
