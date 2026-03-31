/**
 * Deno 2.x smoke test — exercises the published ESM dist artifact.
 *
 * Run:
 *   deno run tests/smoke/deno.test.js
 *
 * Exit 0 = all checks passed.
 * Exit 1 = one or more checks failed.
 *
 * Requires: Deno ≥ 2.0  (https://deno.com)
 * Node compatibility is built into Deno 2.x — no flags required.
 */

import Skalex from "../../dist/skalex.esm.js";

// ─── In-memory adapter (no fs permissions needed) ────────────────────────────

class MemoryAdapter {
  constructor() { this._store = new Map(); }
  async read(name) { return this._store.get(name) ?? null; }
  async write(name, data) { this._store.set(name, data); }
  async delete(name) { this._store.delete(name); }
  async list() { return [...this._store.keys()]; }
  join(...parts) { return parts.join("/"); }
  ensureDir() {}
  async writeRaw(p, c) { this._store.set(`__raw:${p}`, c); }
  async readRaw(p) {
    const v = this._store.get(`__raw:${p}`);
    if (v == null) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return v;
  }
}

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
  const db = new Skalex({ adapter: new MemoryAdapter() });
  await db.connect();

  // ─── Core CRUD ─────────────────────────────────────────────────────────────

  await section("insertOne / find / findOne", async () => {
    const col = db.useCollection("users");
    const data = await col.insertOne({ name: "Deno", role: "admin" });

    assert("insertOne returns _id",                 typeof data._id === "string");
    assert("insertOne sets createdAt as Date",      data.createdAt instanceof Date);

    const found = await col.findOne({ name: "Deno" });
    assert("findOne returns correct doc",           found?.name === "Deno");

    const { docs } = await col.find({ role: "admin" });
    assert("find returns matching docs",            docs.length === 1);
  });

  await section("updateOne / updateMany / deleteOne / deleteMany", async () => {
    const col = db.useCollection("items");
    await col.insertMany([{ v: 1 }, { v: 2 }, { v: 3 }]);

    const res = await col.updateOne({ v: 1 }, { v: 99 });
    assert("updateOne updates the doc",             res?.v === 99);

    await col.updateMany({ v: { $gte: 2 } }, { active: true });
    const { docs: active } = await col.find({ active: true });
    assert("updateMany updates all matching",       active.length === 3);

    await col.deleteOne({ v: 99 });
    assert("deleteOne removes the doc",             (await col.count()) === 2);

    await col.deleteMany({ active: true });
    assert("deleteMany removes all matching",       (await col.count()) === 0);
  });

  // ─── Query operators ───────────────────────────────────────────────────────

  await section("query operators", async () => {
    const col = db.useCollection("qops");
    await col.insertMany([
      { n: 1, tag: "a" },
      { n: 2, tag: "b" },
      { n: 3, tag: "a" },
      { n: 4, tag: "c" },
    ]);

    const { docs: gt } = await col.find({ n: { $gt: 2 } });
    assert("$gt works",                             gt.length === 2);

    const { docs: inArr } = await col.find({ tag: { $in: ["a", "b"] } });
    assert("$in works",                             inArr.length === 3);

    const { docs: nin } = await col.find({ tag: { $nin: ["a"] } });
    assert("$nin works",                            nin.length === 2);

    const { docs: fn } = await col.find({ n: { $fn: v => v % 2 === 0 } });
    assert("$fn works",                             fn.length === 2);

    const { docs: regex } = await col.find({ tag: /^a/ });
    assert("RegExp works",                          regex.length === 2);
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

  // ─── Transaction ───────────────────────────────────────────────────────────

  await section("transaction", async () => {
    const col = db.useCollection("balances");
    await col.insertMany([{ name: "A", bal: 100 }, { name: "B", bal: 50 }]);

    await db.transaction(async (tx) => {
      const c = tx.useCollection("balances");
      await c.updateOne({ name: "A" }, { bal: { $inc: -25 } });
      await c.updateOne({ name: "B" }, { bal: { $inc:  25 } });
    });

    assert("transaction commit: A",                 (await col.findOne({ name: "A" }))?.bal === 75);
    assert("transaction commit: B",                 (await col.findOne({ name: "B" }))?.bal === 75);

    let rolled = false;
    try {
      await db.transaction(async (tx) => {
        await tx.useCollection("balances").updateOne({ name: "A" }, { bal: 0 });
        throw new Error("rollback");
      });
    } catch (_) { rolled = true; }

    assert("transaction rollback",                  rolled && (await col.findOne({ name: "A" }))?.bal === 75);
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
    assert("watch fires correct count",             ops.length === 3);
  });

  // ─── Plugin system ─────────────────────────────────────────────────────────

  await section("plugin system", async () => {
    const log = [];
    db.use({
      async beforeInsert(ctx) { log.push(`before:${ctx.collection}`); },
      async afterInsert(ctx)  { log.push(`after:${!!ctx.doc._id}`);  },
      async afterFind(ctx)    { log.push(`find:${ctx.docs.length}`);  },
    });

    const col = db.useCollection("plug");
    await col.insertOne({ x: 1 });
    await col.find({});

    assert("beforeInsert fired",                    log.includes("before:plug"));
    assert("afterInsert fired",                     log.includes("after:true"));
    assert("afterFind fired",                       log.some(l => l.startsWith("find:")));
  });

  // ─── Session stats ─────────────────────────────────────────────────────────

  await section("session stats", async () => {
    const col = db.useCollection("ss");
    await col.insertOne({ v: 1 }, { session: "deno-1" });
    await col.insertOne({ v: 2 }, { session: "deno-1" });
    await col.find({}, { session: "deno-1" });
    await col.find({}, { session: "deno-1" });

    const s = db.sessionStats("deno-1");
    assert("sessionStats: writes === 2",            s?.writes === 2);
    assert("sessionStats: reads === 2",             s?.reads === 2);
    assert("sessionStats: lastActive is Date",      s?.lastActive instanceof Date);
  });

  // ─── db.stats() ────────────────────────────────────────────────────────────

  await section("db.stats()", async () => {
    const s = db.stats("users");
    assert("stats has collection name",             s?.collection === "users");
    assert("stats has count",                       typeof s?.count === "number");
    const all = db.stats();
    assert("stats() returns array",                 Array.isArray(all));
  });

  // ─── MCP factory ───────────────────────────────────────────────────────────

  await section("db.mcp() factory", async () => {
    const server = db.mcp({ transport: "stdio" });
    assert("mcp() returns server",                  typeof server.listen === "function");
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

  // ─── Upsert / ifNotExists ──────────────────────────────────────────────────

  await section("upsert / ifNotExists", async () => {
    const col = db.useCollection("settings");
    await col.upsert({ key: "lang" }, { value: "en" });
    await col.upsert({ key: "lang" }, { value: "fr" });
    const s = await col.findOne({ key: "lang" });
    assert("upsert updates on second call",         s?.value === "fr");

    const first  = await col.insertOne({ key: "tz", value: "UTC" }, { ifNotExists: true });
    const second = await col.insertOne({ key: "tz", value: "UTC" }, { ifNotExists: true });
    assert("ifNotExists does not duplicate",        first._id === second._id);
  });

  // ─── Disconnect ────────────────────────────────────────────────────────────

  await db.disconnect();

  // ─── Summary ───────────────────────────────────────────────────────────────

  const denoVersion = typeof Deno !== "undefined" ? Deno.version.deno : "unknown";
  console.log(`\n${"─".repeat(50)}`);
  console.log(`Deno ${denoVersion} smoke test`);
  console.log(`Passed: ${passed}  Failed: ${failed}`);
  console.log("─".repeat(50));

  if (failed > 0) Deno.exit(1);
}

run().catch(err => {
  console.error("\nUnhandled error:", err);
  Deno.exit(1);
});
