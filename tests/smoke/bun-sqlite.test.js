/**
 * Bun SQLite adapter smoke test.
 *
 * Verifies that BunSQLiteAdapter correctly implements the StorageAdapter
 * interface using Bun's native bun:sqlite module.
 *
 * Run:
 *   bun tests/smoke/bun-sqlite.test.js
 *
 * Exit 0 = all checks passed.
 * Exit 1 = one or more checks failed.
 *
 * Requires: Bun ≥ 1.0  (https://bun.sh)
 */

import Skalex from "../../dist/skalex.esm.js";
import BunSQLiteAdapter from "../../src/connectors/storage/bun-sqlite.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(label, condition) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

async function section(name, fn) {
  console.log(`\n${name}`);
  try {
    await fn();
  } catch (err) {
    console.error(`  ✗ THREW: ${err.message}`);
    failed++;
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function run() {

  // ─── Adapter conformance ───────────────────────────────────────────────────

  await section("BunSQLiteAdapter — raw adapter interface", async () => {
    const adapter = new BunSQLiteAdapter(":memory:");

    // read missing key
    assert("read() returns null for missing key",   await adapter.read("x") === null);

    // write + read round-trip
    await adapter.write("col1", '{"hello":"bun"}');
    assert("write() + read() round-trip",           await adapter.read("col1") === '{"hello":"bun"}');

    // overwrite
    await adapter.write("col1", "v2");
    assert("write() overwrites existing",           await adapter.read("col1") === "v2");

    // list
    await adapter.write("col2", "v");
    const names = await adapter.list();
    assert("list() contains written keys",          names.includes("col1") && names.includes("col2"));
    assert("list() no duplicates",                  names.filter(n => n === "col1").length === 1);

    // delete
    await adapter.delete("col1");
    assert("delete() removes key",                  await adapter.read("col1") === null);
    assert("list() excludes deleted key",           !(await adapter.list()).includes("col1"));

    // delete missing — should not throw
    await adapter.delete("nonexistent");
    assert("delete() is a no-op for missing key",   true);

    // close
    adapter.close();
    assert("close() does not throw",                true);
  });

  // ─── File-based SQLite database ────────────────────────────────────────────

  await section("BunSQLiteAdapter — file-based database", async () => {
    const path = `/tmp/skalex-bun-sqlite-smoke-${Date.now()}.db`;
    const adapter = new BunSQLiteAdapter(path);

    await adapter.write("test", "hello");
    assert("file db write + read",                  await adapter.read("test") === "hello");

    adapter.close();

    // Re-open same file — data should persist
    const adapter2 = new BunSQLiteAdapter(path);
    assert("data persists across close/reopen",     await adapter2.read("test") === "hello");
    adapter2.close();

    // Cleanup
    try { Bun.file(path).exists().then(() => {}); } catch (_) {}
  });

  // ─── Full Skalex integration via BunSQLiteAdapter ─────────────────────────

  await section("Skalex + BunSQLiteAdapter integration", async () => {
    const db = new Skalex({ adapter: new BunSQLiteAdapter(":memory:") });
    await db.connect();

    const col = db.useCollection("users");
    const data = await col.insertOne({ name: "Bun User", runtime: "bun" });

    assert("insertOne via SQLite adapter",          typeof data._id === "string");

    const { docs } = await col.find({ runtime: "bun" });
    assert("find via SQLite adapter",               docs.length === 1 && docs[0].name === "Bun User");

    await col.updateOne({ name: "Bun User" }, { name: "Updated" });
    const updated = await col.findOne({ name: "Updated" });
    assert("updateOne via SQLite adapter",          updated !== null);

    await col.deleteOne({ name: "Updated" });
    assert("deleteOne via SQLite adapter",          (await col.count()) === 0);

    // Aggregation
    await col.insertMany([{ score: 10 }, { score: 20 }, { score: 30 }]);
    assert("count() via SQLite adapter",            await col.count() === 3);
    assert("sum() via SQLite adapter",              await col.sum("score") === 60);
    assert("avg() via SQLite adapter",              await col.avg("score") === 20);

    await db.disconnect();
    assert("disconnect completes",                  true);
  });

  // ─── Summary ───────────────────────────────────────────────────────────────

  console.log(`\n${"─".repeat(50)}`);
  console.log(`Bun ${Bun.version} — BunSQLiteAdapter smoke test`);
  console.log(`Passed: ${passed}  Failed: ${failed}`);
  console.log("─".repeat(50));

  if (failed > 0) process.exit(1);
}

run().catch(err => {
  console.error("\nUnhandled error:", err);
  process.exit(1);
});
