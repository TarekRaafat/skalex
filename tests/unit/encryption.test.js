/**
 * Unit tests for EncryptedAdapter  -  AES-256-GCM at-rest encryption.
 */
import { describe, test, expect } from "vitest";
import EncryptedAdapter from "../../src/connectors/storage/encrypted.js";
import MemoryAdapter from "../helpers/MemoryAdapter.js";

// 64-char hex → 32-byte AES-256 key
const KEY_HEX = "0".repeat(64);
const KEY_ALT  = "1".repeat(64);

function makeEncrypted(key = KEY_HEX) {
  const inner = new MemoryAdapter();
  const enc   = new EncryptedAdapter(inner, key);
  return { inner, enc };
}

// ─── Construction ────────────────────────────────────────────────────────────

describe("EncryptedAdapter  -  construction", () => {
  test("accepts a 64-char hex key", () => {
    expect(() => makeEncrypted(KEY_HEX)).not.toThrow();
  });

  test("accepts a 32-byte Uint8Array key", () => {
    const key = new Uint8Array(32);
    const inner = new MemoryAdapter();
    expect(() => new EncryptedAdapter(inner, key)).not.toThrow();
  });

  test("throws for a key that is too short (hex)", () => {
    expect(() => makeEncrypted("abc")).toThrow(/key must be/);
  });

  test("throws for a Uint8Array key with wrong length", () => {
    const inner = new MemoryAdapter();
    expect(() => new EncryptedAdapter(inner, new Uint8Array(16))).toThrow();
  });
});

// ─── Write / Read round-trip ──────────────────────────────────────────────────

describe("EncryptedAdapter  -  write / read", () => {
  test("read returns null for missing file", async () => {
    const { enc } = makeEncrypted();
    expect(await enc.read("missing")).toBeNull();
  });

  test("write then read returns the original plaintext", async () => {
    const { enc } = makeEncrypted();
    await enc.write("doc", "hello world");
    expect(await enc.read("doc")).toBe("hello world");
  });

  test("ciphertext stored in inner adapter is not the plaintext", async () => {
    const { inner, enc } = makeEncrypted();
    await enc.write("doc", "secret data");
    const raw = await inner.read("doc");
    expect(raw).not.toBe("secret data");
    expect(raw).not.toContain("secret");
  });

  test("ciphertext is valid base64", async () => {
    const { inner, enc } = makeEncrypted();
    await enc.write("doc", "data");
    const raw = await inner.read("doc");
    expect(() => atob(raw)).not.toThrow();
  });

  test("each write produces a different ciphertext (random IV)", async () => {
    const { inner, enc } = makeEncrypted();
    await enc.write("a", "same plaintext");
    const c1 = await inner.read("a");
    await enc.write("a", "same plaintext");
    const c2 = await inner.read("a");
    expect(c1).not.toBe(c2);
  });

  test("wrong key cannot decrypt ciphertext", async () => {
    const { inner } = makeEncrypted(KEY_HEX);
    const enc2 = new EncryptedAdapter(inner, KEY_ALT);
    await new EncryptedAdapter(inner, KEY_HEX).write("doc", "private");
    await expect(enc2.read("doc")).rejects.toThrow();
  });

  test("round-trips JSON content faithfully", async () => {
    const { enc } = makeEncrypted();
    const payload = JSON.stringify({ collectionName: "test", data: [{ _id: "1", val: 42 }] });
    await enc.write("test", payload);
    const result = await enc.read("test");
    expect(JSON.parse(result)).toEqual(JSON.parse(payload));
  });

  test("handles empty string round-trip", async () => {
    const { enc } = makeEncrypted();
    await enc.write("empty", "");
    expect(await enc.read("empty")).toBe("");
  });

  test("handles unicode / multi-byte content", async () => {
    const { enc } = makeEncrypted();
    const text = "日本語テスト 🔐 émoji";
    await enc.write("unicode", text);
    expect(await enc.read("unicode")).toBe(text);
  });
});

// ─── delete / list ────────────────────────────────────────────────────────────

describe("EncryptedAdapter  -  delete / list", () => {
  test("delete() removes file from inner adapter", async () => {
    const { enc } = makeEncrypted();
    await enc.write("to-delete", "data");
    await enc.delete("to-delete");
    expect(await enc.read("to-delete")).toBeNull();
  });

  test("list() returns all stored names", async () => {
    const { enc } = makeEncrypted();
    await enc.write("a", "1");
    await enc.write("b", "2");
    const names = await enc.list();
    expect(names).toContain("a");
    expect(names).toContain("b");
  });
});

// ─── Integration: Skalex with encrypt config ─────────────────────────────────

describe("Skalex encrypt config", () => {
  test("db data is readable after connect/disconnect cycle", async () => {
    const inner = new MemoryAdapter();
    const Skalex = (await import("../../src/index.js")).default;

    const db = new Skalex({ adapter: inner, encrypt: { key: KEY_HEX } });
    await db.connect();
    const users = db.useCollection("users");
    await users.insertOne({ name: "Alice" });
    await db.saveData();
    await db.disconnect();

    // Reconnect with same key
    const db2 = new Skalex({ adapter: inner, encrypt: { key: KEY_HEX } });
    await db2.connect();
    const doc = await db2.useCollection("users").findOne({ name: "Alice" });
    expect(doc).not.toBeNull();
    expect(doc.name).toBe("Alice");
    await db2.disconnect();
  });

  test("raw adapter bytes are not readable plaintext", async () => {
    const inner = new MemoryAdapter();
    const Skalex = (await import("../../src/index.js")).default;

    const db = new Skalex({ adapter: inner, encrypt: { key: KEY_HEX } });
    await db.connect();
    await db.useCollection("secrets").insertOne({ password: "hunter2" });
    await db.saveData();
    await db.disconnect();

    // Read raw bytes without decryption
    const names = await inner.list();
    for (const name of names) {
      const raw = await inner.read(name);
      expect(raw).not.toContain("hunter2");
    }
  });
});
