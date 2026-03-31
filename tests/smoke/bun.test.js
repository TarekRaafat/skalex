/**
 * Bun 1.x smoke test — exercises the published ESM dist artifact.
 *
 * Run:
 *   bun tests/smoke/bun.test.js
 *
 * Exit 0 = all checks passed.
 * Exit 1 = one or more checks failed.
 *
 * Requires: Bun ≥ 1.0  (https://bun.sh)
 */

import Skalex from "../../dist/skalex.esm.js";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

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

// ─── Setup ───────────────────────────────────────────────────────────────────

const tmpDir = mkdtempSync(join(tmpdir(), "skalex-bun-smoke-"));

async function run() {
  const db = new Skalex({ path: tmpDir, format: "json" });
  await db.connect();

  // ─── Core CRUD ─────────────────────────────────────────────────────────────

  await section("insertOne / find / findOne", async () => {
    const col = db.useCollection("users");
    const data = await col.insertOne({ name: "Alice", role: "admin" });

    assert("insertOne returns _id",                 typeof data._id === "string");
    assert("insertOne sets createdAt as Date",      data.createdAt instanceof Date);

    const found = await col.findOne({ name: "Alice" });
    assert("findOne returns correct doc",           found?.name === "Alice");

    const { docs } = await col.find({ role: "admin" });
    assert("find returns matching docs",            docs.length === 1);
  });

  await section("insertMany / updateOne / deleteOne", async () => {
    const col = db.useCollection("items");
    const docs = await col.insertMany([{ v: 1 }, { v: 2 }, { v: 3 }]);
    assert("insertMany returns all docs",           docs.length === 3);

    await col.updateOne({ v: 1 }, { v: 99 });
    const updated = await col.findOne({ v: 99 });
    assert("updateOne updates the doc",             updated !== null);

    await col.deleteOne({ v: 2 });
    const { docs: remaining } = await col.find({});
    assert("deleteOne removes the doc",             remaining.length === 2);
  });

  // ─── Aggregation ───────────────────────────────────────────────────────────

  await section("count / sum / avg / groupBy", async () => {
    const col = db.useCollection("orders");
    await col.insertMany([
      { product: "A", amount: 10 },
      { product: "B", amount: 20 },
      { product: "A", amount: 30 },
    ]);

    assert("count()",                               await col.count() === 3);
    assert("sum()",                                 await col.sum("amount") === 60);
    assert("avg()",                                 await col.avg("amount") === 20);
    const groups = await col.groupBy("product");
    assert("groupBy()",                             groups.A?.length === 2);
  });

  // ─── Sort & Pagination ─────────────────────────────────────────────────────

  await section("sort / pagination", async () => {
    const col = db.useCollection("nums");
    await col.insertMany([{ n: 3 }, { n: 1 }, { n: 2 }]);

    const { docs: asc } = await col.find({}, { sort: { n: 1 } });
    assert("sort ascending",                        asc.map(d => d.n).join(",") === "1,2,3");

    const page = await col.find({}, { sort: { n: 1 }, page: 1, limit: 2 });
    assert("pagination totalDocs",                  page.totalDocs === 3);
    assert("pagination docs on page",               page.docs.length === 2);
  });

  // ─── Transaction ───────────────────────────────────────────────────────────

  await section("transaction", async () => {
    const col = db.useCollection("balances");
    await col.insertMany([{ name: "A", bal: 100 }, { name: "B", bal: 50 }]);

    await db.transaction(async (tx) => {
      const c = tx.useCollection("balances");
      await c.updateOne({ name: "A" }, { bal: { $inc: -10 } });
      await c.updateOne({ name: "B" }, { bal: { $inc:  10 } });
    });

    const a = await col.findOne({ name: "A" });
    const b = await col.findOne({ name: "B" });
    assert("transaction commit applied",            a.bal === 90 && b.bal === 60);
  });

  // ─── Watch ─────────────────────────────────────────────────────────────────

  await section("collection.watch()", async () => {
    const col = db.useCollection("events");
    const ops = [];
    const unsub = col.watch(e => ops.push(e.op));

    await col.insertOne({ x: 1 });
    await col.updateOne({ x: 1 }, { x: 2 });
    await col.deleteOne({ x: 2 });
    unsub();

    assert("watch fires insert/update/delete",      ops.join(",") === "insert,update,delete");
  });

  // ─── Plugin system ─────────────────────────────────────────────────────────

  await section("plugin system", async () => {
    const log = [];
    db.use({
      async beforeInsert(ctx) { log.push(`before:${ctx.collection}`); },
      async afterInsert(ctx)  { log.push(`after:${!!ctx.doc._id}`); },
    });

    const col = db.useCollection("plug");
    await col.insertOne({ x: 1 });

    assert("beforeInsert fired",                    log[0] === "before:plug");
    assert("afterInsert fired with _id set",        log[1] === "after:true");
  });

  // ─── Session stats ─────────────────────────────────────────────────────────

  await section("session stats", async () => {
    const col = db.useCollection("ss");
    await col.insertOne({ v: 1 }, { session: "s1" });
    await col.insertOne({ v: 2 }, { session: "s1" });
    await col.find({}, { session: "s1" });

    const s = db.sessionStats("s1");
    assert("sessionStats: writes === 2",            s?.writes === 2);
    assert("sessionStats: reads === 1",             s?.reads === 1);
    assert("sessionStats: lastActive is Date",      s?.lastActive instanceof Date);
  });

  // ─── MCP factory ───────────────────────────────────────────────────────────

  await section("db.mcp() factory", async () => {
    const server = db.mcp({ transport: "stdio" });
    assert("mcp() transport is stdio",              server.transport === "stdio");
    assert("mcp() has listen()",                    typeof server.listen === "function");
  });

  // ─── Connector barrels ─────────────────────────────────────────────────────

  await section("connector barrels", async () => {
    const storage   = await import("../../src/connectors/storage/index.js");
    const embedding = await import("../../src/connectors/embedding/index.js");
    const llm       = await import("../../src/connectors/llm/index.js");
    const root      = await import("../../src/connectors/index.js");

    assert("connectors/storage — FsAdapter",             typeof storage.FsAdapter === "function");
    assert("connectors/storage — LocalStorageAdapter",   typeof storage.LocalStorageAdapter === "function");
    assert("connectors/storage — EncryptedAdapter",      typeof storage.EncryptedAdapter === "function");
    assert("connectors/storage — BunSQLiteAdapter",      typeof storage.BunSQLiteAdapter === "function");
    assert("connectors/storage — D1Adapter",             typeof storage.D1Adapter === "function");
    assert("connectors/storage — LibSQLAdapter",         typeof storage.LibSQLAdapter === "function");
    assert("connectors/embedding — OpenAIEmbeddingAdapter", typeof embedding.OpenAIEmbeddingAdapter === "function");
    assert("connectors/embedding — OllamaEmbeddingAdapter", typeof embedding.OllamaEmbeddingAdapter === "function");
    assert("connectors/llm — OpenAILLMAdapter",          typeof llm.OpenAILLMAdapter === "function");
    assert("connectors/llm — AnthropicLLMAdapter",       typeof llm.AnthropicLLMAdapter === "function");
    assert("connectors/llm — OllamaLLMAdapter",          typeof llm.OllamaLLMAdapter === "function");
    assert("connectors root barrel — all adapter types", typeof root.FsAdapter === "function" &&
                                                         typeof root.OpenAIEmbeddingAdapter === "function" &&
                                                         typeof root.OpenAILLMAdapter === "function");
  });

  // ─── Disconnect ────────────────────────────────────────────────────────────

  await db.disconnect();

  // ─── Summary ───────────────────────────────────────────────────────────────

  console.log(`\n${"─".repeat(50)}`);
  console.log(`Bun ${Bun.version} smoke test`);
  console.log(`Passed: ${passed}  Failed: ${failed}`);
  console.log("─".repeat(50));

  if (failed > 0) process.exit(1);
}

run().catch(err => {
  console.error("\nUnhandled error:", err);
  process.exit(1);
}).finally(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});
