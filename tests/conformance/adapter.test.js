/**
 * Adapter conformance test suite.
 *
 * Runs the same read/write/delete/list contract tests against every
 * StorageAdapter implementation that can run in the Node.js test environment.
 *
 * Adapters tested here:
 *   - MemoryAdapter         (always available)
 *   - FsAdapter (json)      (Node.js fs)
 *   - FsAdapter (gz)        (Node.js fs, compressed)
 *   - EncryptedAdapter      (MemoryAdapter + AES-256-GCM)
 *
 * Adapters NOT tested here (require their own runtime / external service):
 *   - BunSQLiteAdapter      → run in Bun: `bun test`
 *   - D1Adapter             → run in Cloudflare Worker environment
 *   - LibSQLAdapter         → run with a real @libsql/client connection
 *   - LocalStorageAdapter   → run in a browser environment
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import MemoryAdapter    from "../helpers/MemoryAdapter.js";
import FsAdapter        from "../../src/adapters/storage/fs.js";
import EncryptedAdapter from "../../src/adapters/storage/encrypted.js";

// ─── Test key for EncryptedAdapter ────────────────────────────────────────────

// 32 random bytes expressed as a 64-char hex string
const TEST_KEY = "a".repeat(64);

// ─── Conformance factory ──────────────────────────────────────────────────────

/**
 * Runs the full conformance suite against `factory()`.
 * `factory()` is called before each test and must return a fresh adapter.
 * `cleanup()` is called after each test to remove any temp resources.
 */
function adapterConformance(label, factory, cleanup = () => {}) {
  describe(`${label} — conformance`, () => {
    let adapter;

    beforeEach(() => { adapter = factory(); });
    afterEach(cleanup);

    // ─── read ──────────────────────────────────────────────────────────────

    test("read() returns null for a missing key", async () => {
      expect(await adapter.read("nonexistent")).toBeNull();
    });

    test("read() returns the value written by write()", async () => {
      await adapter.write("col1", '{"hello":"world"}');
      expect(await adapter.read("col1")).toBe('{"hello":"world"}');
    });

    test("read() is isolated per name", async () => {
      await adapter.write("a", "aaa");
      await adapter.write("b", "bbb");
      expect(await adapter.read("a")).toBe("aaa");
      expect(await adapter.read("b")).toBe("bbb");
    });

    // ─── write ────────────────────────────────────────────────────────────

    test("write() overwrites an existing value", async () => {
      await adapter.write("col1", "first");
      await adapter.write("col1", "second");
      expect(await adapter.read("col1")).toBe("second");
    });

    test("write() stores arbitrary JSON strings", async () => {
      const payload = JSON.stringify({ collectionName: "users", data: [{ _id: "1" }] });
      await adapter.write("users", payload);
      expect(await adapter.read("users")).toBe(payload);
    });

    test("write() stores empty string", async () => {
      await adapter.write("empty", "");
      expect(await adapter.read("empty")).toBe("");
    });

    // ─── delete ───────────────────────────────────────────────────────────

    test("delete() removes a stored key", async () => {
      await adapter.write("col1", "data");
      await adapter.delete("col1");
      expect(await adapter.read("col1")).toBeNull();
    });

    test("delete() is a no-op for a missing key", async () => {
      // Should not throw
      await expect(adapter.delete("nonexistent")).resolves.not.toThrow();
    });

    test("delete() does not affect other keys", async () => {
      await adapter.write("a", "aaa");
      await adapter.write("b", "bbb");
      await adapter.delete("a");
      expect(await adapter.read("b")).toBe("bbb");
    });

    // ─── list ─────────────────────────────────────────────────────────────

    test("list() returns an empty array when nothing is stored", async () => {
      const names = await adapter.list();
      expect(Array.isArray(names)).toBe(true);
      expect(names.length).toBe(0);
    });

    test("list() includes written keys", async () => {
      await adapter.write("users", "u");
      await adapter.write("orders", "o");
      const names = await adapter.list();
      expect(names).toContain("users");
      expect(names).toContain("orders");
    });

    test("list() excludes deleted keys", async () => {
      await adapter.write("a", "aaa");
      await adapter.write("b", "bbb");
      await adapter.delete("a");
      const names = await adapter.list();
      expect(names).not.toContain("a");
      expect(names).toContain("b");
    });

    test("list() does not return duplicate names after overwrite", async () => {
      await adapter.write("col1", "v1");
      await adapter.write("col1", "v2");
      const names = await adapter.list();
      expect(names.filter(n => n === "col1").length).toBe(1);
    });

    // ─── round-trip ───────────────────────────────────────────────────────

    test("round-trip: write many, read many, list, delete all", async () => {
      const keys = ["alpha", "beta", "gamma", "delta"];
      for (const k of keys) await adapter.write(k, `value-${k}`);

      for (const k of keys) {
        expect(await adapter.read(k)).toBe(`value-${k}`);
      }

      const listed = await adapter.list();
      for (const k of keys) expect(listed).toContain(k);

      for (const k of keys) await adapter.delete(k);

      const afterDelete = await adapter.list();
      for (const k of keys) expect(afterDelete).not.toContain(k);
    });
  });
}

// ─── MemoryAdapter ────────────────────────────────────────────────────────────

adapterConformance("MemoryAdapter", () => new MemoryAdapter());

// ─── FsAdapter (json) ─────────────────────────────────────────────────────────

{
  let tmpDir;
  adapterConformance(
    "FsAdapter (json)",
    () => {
      tmpDir = mkdtempSync(join(tmpdir(), "skalex-conformance-json-"));
      return new FsAdapter({ dir: tmpDir, format: "json" });
    },
    () => {
      if (tmpDir) {
        try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
        tmpDir = null;
      }
    }
  );
}

// ─── FsAdapter (gz) ──────────────────────────────────────────────────────────

{
  let tmpDir;
  adapterConformance(
    "FsAdapter (gz)",
    () => {
      tmpDir = mkdtempSync(join(tmpdir(), "skalex-conformance-gz-"));
      return new FsAdapter({ dir: tmpDir, format: "gz" });
    },
    () => {
      if (tmpDir) {
        try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
        tmpDir = null;
      }
    }
  );
}

// ─── EncryptedAdapter (wrapping MemoryAdapter) ───────────────────────────────

adapterConformance(
  "EncryptedAdapter(MemoryAdapter)",
  () => new EncryptedAdapter(new MemoryAdapter(), TEST_KEY)
);
