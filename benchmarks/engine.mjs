#!/usr/bin/env node
/**
 * benchmarks/engine.mjs  -  repeatable profiling script for core engine operations.
 *
 * Run:   node benchmarks/engine.mjs
 * Output: table of operations with throughput and latency numbers.
 *
 * No timing assertions - this is a manual tool for tracking before/after
 * numbers across refactors. Record results in commit messages or a tracking doc.
 */

// ─── Helpers ────────────────────────────────────────────────────────────────

class MemoryAdapter {
  constructor() { this._store = new Map(); }
  async read(name) { return this._store.get(name) ?? null; }
  async write(name, data) { this._store.set(name, data); }
  async writeAll(entries) { for (const { name, data } of entries) this._store.set(name, data); }
  async delete(name) { this._store.delete(name); }
  async list() { return [...this._store.keys()]; }
}

async function time(label, fn) {
  const start = performance.now();
  const result = await fn();
  const ms = performance.now() - start;
  return { label, ms, result };
}

function fmt(ms) {
  return ms < 1 ? `${(ms * 1000).toFixed(0)}µs` : `${ms.toFixed(2)}ms`;
}

// ─── Benchmark ──────────────────────────────────────────────────────────────

const { default: Skalex } = await import("../src/index.js");

const results = [];

// 1. insertMany(1000) throughput
{
  const db = new Skalex({ adapter: new MemoryAdapter() });
  await db.connect();
  const col = db.useCollection("bench");
  const docs = Array.from({ length: 1000 }, (_, i) => ({ name: `user_${i}`, score: i }));
  const r = await time("insertMany(1000)", () => col.insertMany(docs));
  results.push({ ...r, ops: Math.round(1000 / (r.ms / 1000)) });
  await db.disconnect();
}

// 2. Indexed findOne latency
{
  const db = new Skalex({ adapter: new MemoryAdapter() });
  const col = db.createCollection("bench", { indexes: ["name"] });
  await db.connect();
  const docs = Array.from({ length: 10000 }, (_, i) => ({ name: `user_${i}`, score: i }));
  await col.insertMany(docs);
  // Warm up
  await col.findOne({ name: "user_5000" });
  const r = await time("indexed findOne (10k docs)", () => col.findOne({ name: "user_9999" }));
  results.push(r);
  await db.disconnect();
}

// 3. Full find scan over 10k docs
{
  const db = new Skalex({ adapter: new MemoryAdapter() });
  await db.connect();
  const col = db.useCollection("bench");
  const docs = Array.from({ length: 10000 }, (_, i) => ({ name: `user_${i}`, score: i % 100 }));
  await col.insertMany(docs);
  const r = await time("find scan (10k docs, ~100 match)", () => col.find({ score: 42 }));
  results.push({ ...r, count: r.result.docs.length });
  await db.disconnect();
}

// 4. saveData on 1 dirty collection vs 10 total
{
  const db = new Skalex({ adapter: new MemoryAdapter() });
  await db.connect();
  for (let i = 0; i < 10; i++) {
    const c = db.useCollection(`col_${i}`);
    await c.insertMany(Array.from({ length: 500 }, (_, j) => ({ x: j })));
  }
  await db.saveData(); // baseline: save all

  // Mutate only col_0
  await db.useCollection("col_0").insertOne({ x: 999 });

  const rAll = await time("saveData() all 10 collections", () => db.saveData());
  results.push(rAll);

  await db.useCollection("col_0").insertOne({ x: 998 });
  const rDirty = await time("saveDirty() 1 of 10 collections", () => db._persistence.saveDirty(db.collections));
  results.push(rDirty);

  await db.disconnect();
}

// 5. Transaction touching 1 of 20 collections (lazy snapshot)
{
  const db = new Skalex({ adapter: new MemoryAdapter() });
  await db.connect();
  for (let i = 0; i < 20; i++) {
    const c = db.useCollection(`col_${i}`);
    await c.insertMany(Array.from({ length: 200 }, (_, j) => ({ x: j })));
  }
  await db.saveData();

  const r = await time("transaction() touching 1 of 20 collections", async () => {
    await db.transaction(async (tx) => {
      await tx.useCollection("col_5").insertOne({ x: 999 });
    });
  });
  results.push(r);
  await db.disconnect();
}

// 6. Compound index lookup
{
  const db = new Skalex({ adapter: new MemoryAdapter() });
  const col = db.createCollection("bench", { indexes: [["tenantId", "status"]] });
  await db.connect();
  const docs = Array.from({ length: 10000 }, (_, i) => ({
    tenantId: `t${i % 50}`,
    status: i % 3 === 0 ? "active" : "inactive",
    val: i,
  }));
  await col.insertMany(docs);
  // Warm up
  await col.find({ tenantId: "t25", status: "active" });
  const r = await time("compound index find (10k docs)", () => col.find({ tenantId: "t25", status: "active" }));
  results.push({ ...r, count: r.result.docs.length });
  await db.disconnect();
}

// 7. $or query
{
  const db = new Skalex({ adapter: new MemoryAdapter() });
  await db.connect();
  const col = db.useCollection("bench");
  const docs = Array.from({ length: 10000 }, (_, i) => ({ name: `user_${i}`, group: i % 10 }));
  await col.insertMany(docs);
  const r = await time("$or query (10k docs)", () =>
    col.find({ $or: [{ group: 3 }, { group: 7 }] })
  );
  results.push({ ...r, count: r.result.docs.length });
  await db.disconnect();
}

// ─── Report ─────────────────────────────────────────────────────────────────

console.log("\n=== Skalex Engine Benchmark ===\n");
console.log("Operation".padEnd(50), "Time".padStart(10), "Extra".padStart(15));
console.log("-".repeat(75));
for (const r of results) {
  const extra = r.ops ? `${r.ops} ops/s` : r.count !== undefined ? `${r.count} docs` : "";
  console.log(r.label.padEnd(50), fmt(r.ms).padStart(10), extra.padStart(15));
}
console.log();
