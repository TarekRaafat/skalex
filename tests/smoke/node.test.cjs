/**
 * Node.js ≥ 20 smoke test — exercises the published CJS dist artifact.
 *
 * Run:
 *   node tests/smoke/node.test.js
 *
 * Exit 0 = all checks passed.
 * Exit 1 = one or more checks failed.
 */

"use strict";

const Skalex = require("../../dist/skalex.cjs");
const { tmpdir } = require("os");
const { mkdtempSync, rmSync } = require("fs");
const { join } = require("path");

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

const tmpDir = mkdtempSync(join(tmpdir(), "skalex-node-smoke-"));

async function run() {
  const db = new Skalex({ path: tmpDir, format: "json" });
  await db.connect();

  // ─── Insert ────────────────────────────────────────────────────────────────

  await section("insertOne / findOne / find", async () => {
    const col = db.useCollection("users");
    const alice = await col.insertOne({ name: "Alice", role: "admin", age: 30 });
    const bob   = await col.insertOne({ name: "Bob",   role: "user",  age: 25 });

    assert("insertOne returns doc with _id",        typeof alice._id === "string");
    assert("insertOne sets createdAt",              alice.createdAt instanceof Date);
    assert("insertOne sets updatedAt",              alice.updatedAt instanceof Date);
    assert("insertOne returns correct fields",      bob.name === "Bob" && bob.role === "user" && bob.age === 25);

    const found = await col.findOne({ name: "Alice" });
    assert("findOne returns correct doc",           found?.name === "Alice");

    const { docs } = await col.find({ role: "admin" });
    assert("find returns matching docs",            docs.length === 1 && docs[0].name === "Alice");

    const { docs: all } = await col.find({});
    assert("find({}) returns all docs",             all.length === 2);
  });

  // ─── insertMany ────────────────────────────────────────────────────────────

  await section("insertMany", async () => {
    const col = db.useCollection("items");
    const docs = await col.insertMany([{ v: 1 }, { v: 2 }, { v: 3 }]);
    assert("insertMany returns all docs",           docs.length === 3);
    assert("insertMany assigns _id to each",        docs.every(d => typeof d._id === "string"));
  });

  // ─── Update ────────────────────────────────────────────────────────────────

  await section("updateOne / updateMany / $inc / $push", async () => {
    const col = db.useCollection("users");
    const res = await col.updateOne({ name: "Alice" }, { age: { $inc: 1 } });
    assert("updateOne $inc works",                  res?.age === 31);

    await col.updateOne({ name: "Alice" }, { tags: [] });
    await col.updateOne({ name: "Alice" }, { tags: { $push: "vip" } });
    const updated = await col.findOne({ name: "Alice" });
    assert("updateOne $push works",                 updated?.tags?.[0] === "vip");

    await col.updateMany({}, { active: true });
    const { docs } = await col.find({ active: true });
    assert("updateMany updates all matching",       docs.length === 2);
  });

  // ─── Upsert / ifNotExists ──────────────────────────────────────────────────

  await section("upsert / ifNotExists", async () => {
    const col = db.useCollection("settings");
    await col.upsert({ key: "theme" }, { value: "dark" });
    await col.upsert({ key: "theme" }, { value: "light" });
    const s = await col.findOne({ key: "theme" });
    assert("upsert updates on second call",         s?.value === "light");

    const first  = await col.insertOne({ key: "lang", value: "en" }, { ifNotExists: true });
    const second = await col.insertOne({ key: "lang", value: "en" }, { ifNotExists: true });
    assert("ifNotExists returns existing on dup",   first._id === second._id);
  });

  // ─── Delete ────────────────────────────────────────────────────────────────

  await section("deleteOne / deleteMany", async () => {
    const col = db.useCollection("scratch");
    await col.insertMany([{ tag: "a" }, { tag: "b" }, { tag: "b" }]);

    const del = await col.deleteOne({ tag: "a" });
    assert("deleteOne returns deleted doc",         del?.tag === "a");

    const docs = await col.deleteMany({ tag: "b" });
    assert("deleteMany returns all deleted docs",   docs.length === 2);

    const { docs: remaining } = await col.find({});
    assert("collection empty after deletes",        remaining.length === 0);
  });

  // ─── TTL ───────────────────────────────────────────────────────────────────

  await section("TTL documents", async () => {
    const col = db.useCollection("sessions");
    const data = await col.insertOne({ token: "abc" }, { ttl: 1 }); // 1 second
    assert("TTL doc has _expiresAt",                data._expiresAt instanceof Date);
    assert("_expiresAt is in the future",           data._expiresAt > new Date());
  });

  // ─── Aggregation ───────────────────────────────────────────────────────────

  await section("count / sum / avg / groupBy", async () => {
    const col = db.useCollection("orders");
    await col.insertMany([
      { product: "Widget", amount: 10, status: "paid"    },
      { product: "Gadget", amount: 30, status: "pending" },
      { product: "Widget", amount: 20, status: "paid"    },
    ]);

    assert("count() total",                         await col.count() === 3);
    assert("count(filter)",                         await col.count({ status: "paid" }) === 2);
    assert("sum()",                                 await col.sum("amount") === 60);
    assert("sum(filter)",                           await col.sum("amount", { status: "paid" }) === 30);
    assert("avg()",                                 Math.abs(await col.avg("amount") - 20) < 0.01);
    const groups = await col.groupBy("product");
    assert("groupBy() correct keys",                Object.keys(groups).sort().join(",") === "Gadget,Widget");
    assert("groupBy() correct counts",              groups.Widget.length === 2);
  });

  // ─── Schema validation ─────────────────────────────────────────────────────

  await section("schema validation", async () => {
    db.createCollection("products", {
      schema: {
        name:  { type: "string",  required: true },
        price: { type: "number",  required: true },
        sku:   { type: "string",  unique: true },
      },
    });
    const col = db.useCollection("products");
    await col.insertOne({ name: "Widget", price: 9.99, sku: "W1" });

    let threw = false;
    try { await col.insertOne({ price: 5 }); } catch (_) { threw = true; }
    assert("schema: required field throws",         threw);

    let threw2 = false;
    try { await col.insertOne({ name: "X", price: 1, sku: "W1" }); } catch (_) { threw2 = true; }
    assert("schema: unique constraint throws",      threw2);
  });

  // ─── Sorting & Pagination ──────────────────────────────────────────────────

  await section("sort / pagination", async () => {
    const col = db.useCollection("nums");
    await col.insertMany([{ n: 3 }, { n: 1 }, { n: 2 }]);

    const { docs: asc } = await col.find({}, { sort: { n: 1 } });
    assert("sort ascending",                        asc.map(d => d.n).join(",") === "1,2,3");

    const { docs: desc } = await col.find({}, { sort: { n: -1 } });
    assert("sort descending",                       desc.map(d => d.n).join(",") === "3,2,1");

    const page = await col.find({}, { sort: { n: 1 }, page: 1, limit: 2 });
    assert("pagination: totalDocs",                 page.totalDocs === 3);
    assert("pagination: totalPages",                page.totalPages === 2);
    assert("pagination: docs on page 1",            page.docs.length === 2);
  });

  // ─── Transactions ──────────────────────────────────────────────────────────

  await section("transaction — commit and rollback", async () => {
    const col = db.useCollection("accounts");
    await col.insertMany([
      { name: "Alice", balance: 100 },
      { name: "Bob",   balance: 50  },
    ]);

    await db.transaction(async (tx) => {
      const c = tx.useCollection("accounts");
      await c.updateOne({ name: "Alice" }, { balance: { $inc: -10 } });
      await c.updateOne({ name: "Bob" },   { balance: { $inc:  10 } });
    });

    const alice   = await col.findOne({ name: "Alice" });
    const bob     = await col.findOne({ name: "Bob" });
    assert("transaction commit: Alice balance",     alice.balance === 90);
    assert("transaction commit: Bob balance",       bob.balance === 60);

    let threw = false;
    try {
      await db.transaction(async (tx) => {
        const c = tx.useCollection("accounts");
        await c.updateOne({ name: "Alice" }, { balance: { $inc: -999 } });
        throw new Error("Simulated error — rollback");
      });
    } catch (_) { threw = true; }

    const aliceAfter = await col.findOne({ name: "Alice" });
    assert("transaction rollback on error",         threw && aliceAfter.balance === 90);
  });

  // ─── Reactive (watch) ──────────────────────────────────────────────────────

  await section("collection.watch()", async () => {
    const col = db.useCollection("events");
    const events = [];
    const unsub = col.watch(e => events.push(e));

    await col.insertOne({ type: "login" });
    await col.updateOne({ type: "login" }, { type: "logout" });
    await col.deleteOne({ type: "logout" });

    unsub();
    await col.insertOne({ type: "should-be-ignored" });

    assert("watch fires on insert",                 events.some(e => e.op === "insert"));
    assert("watch fires on update",                 events.some(e => e.op === "update"));
    assert("watch fires on delete",                 events.some(e => e.op === "delete"));
    assert("unsub stops events",                    events.length === 3);
  });

  // ─── Plugin system ─────────────────────────────────────────────────────────

  await section("plugin system (db.use())", async () => {
    const plugDb = new Skalex({ path: tmpDir + "/plugins", format: "json" });
    await plugDb.connect();

    const log = [];
    plugDb.use({
      async beforeInsert(ctx) { log.push(`before:${ctx.collection}`); },
      async afterInsert(ctx)  { log.push(`after:${ctx.doc._id ? "hasId" : "noId"}`); },
      async beforeFind(ctx)   { log.push("beforeFind"); },
      async afterFind(ctx)    { log.push(`afterFind:${ctx.docs.length}`); },
    });

    const col = plugDb.useCollection("plug");
    await col.insertOne({ x: 1 });
    await col.find({});

    assert("beforeInsert fired",                    log.includes("before:plug"));
    assert("afterInsert fired with _id",            log.includes("after:hasId"));
    assert("beforeFind fired",                      log.includes("beforeFind"));
    assert("afterFind fired with doc count",        log.includes("afterFind:1"));

    await plugDb.disconnect();
  });

  // ─── Session stats ─────────────────────────────────────────────────────────

  await section("session stats (db.sessionStats())", async () => {
    const col = db.useCollection("stats-test");
    await col.insertOne({ v: 1 }, { session: "user-1" });
    await col.insertOne({ v: 2 }, { session: "user-1" });
    await col.find({}, { session: "user-1" });
    await col.updateOne({ v: 1 }, { v: 99 }, { session: "user-1" });

    const s = db.sessionStats("user-1");
    assert("sessionStats: correct write count",     s.writes === 3);
    assert("sessionStats: correct read count",      s.reads === 1);
    assert("sessionStats: lastActive is Date",      s.lastActive instanceof Date);

    const all = db.sessionStats();
    assert("sessionStats(): all() returns array",   Array.isArray(all));
    assert("sessionStats(): contains user-1",       all.some(e => e.sessionId === "user-1"));
  });

  // ─── db.stats() ────────────────────────────────────────────────────────────

  await section("db.stats()", async () => {
    const s = db.stats("users");
    assert("stats has collection name",             s?.collection === "users");
    assert("stats has count > 0",                   s?.count > 0);
    assert("stats has estimatedSize > 0",           s?.estimatedSize > 0);
    assert("stats has avgDocSize > 0",              s?.avgDocSize > 0);

    const all = db.stats();
    assert("stats() returns array",                 Array.isArray(all));
  });

  // ─── db.dump / db.inspect ──────────────────────────────────────────────────

  await section("db.dump() / db.inspect()", async () => {
    const dump = db.dump();
    assert("dump() returns object with users key",  "users" in dump);
    assert("dump() users is an array",              Array.isArray(dump.users));

    const info = db.inspect("users");
    assert("inspect() has count",                   typeof info?.count === "number");
    assert("inspect() has indexes array",           Array.isArray(info?.indexes));
  });

  // ─── Namespace ─────────────────────────────────────────────────────────────

  await section("db.namespace()", async () => {
    const ns = db.namespace("tenant-1");
    await ns.connect();
    const col = ns.useCollection("data");
    await col.insertOne({ tenant: "t1" });
    const { docs } = await col.find({});
    assert("namespace: data isolated",              docs.length === 1 && docs[0].tenant === "t1");
    await ns.disconnect();
  });

  // ─── Seed ──────────────────────────────────────────────────────────────────

  await section("db.seed()", async () => {
    await db.seed({
      seeds: [{ color: "red" }, { color: "blue" }],
    }, { reset: true });
    const { docs } = await db.useCollection("seeds").find({});
    assert("seed() inserts fixtures",               docs.length === 2);
  });

  // ─── ChangeLog ─────────────────────────────────────────────────────────────

  await section("changelog / restore", async () => {
    db.createCollection("ledger", { changelog: true });
    const col = db.useCollection("ledger");
    await col.insertOne({ amount: 100 }, { session: "admin" });
    const snap = new Date();
    await new Promise(r => setTimeout(r, 5)); // ensure update timestamp > snap
    await col.updateOne({ amount: 100 }, { amount: 999 });

    const entries = await db.changelog().query("ledger");
    assert("changelog records insert",              entries.some(e => e.op === "insert"));
    assert("changelog records update",              entries.some(e => e.op === "update"));
    assert("changelog entry has session",           entries[0].session === "admin");

    await db.restore("ledger", snap);
    const restored = await col.findOne({ amount: 100 });
    assert("restore() rolls back update",           restored?.amount === 100);
  });

  // ─── MCP server factory ────────────────────────────────────────────────────

  await section("db.mcp() factory", async () => {
    const server = db.mcp({ transport: "stdio" });
    assert("mcp() returns server with listen fn",   typeof server.listen === "function");
    assert("mcp() returns server with close fn",    typeof server.close === "function");
    assert("mcp() transport is stdio",              server.transport === "stdio");
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
  console.log(`Node.js ${process.version} smoke test`);
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
