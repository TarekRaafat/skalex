/**
 * Reproduce release-audit contracts against source or an unpacked npm package.
 * Run: bun tests/reconciliation/run.mjs <root> <source|package> <output.json>
 * Exits nonzero while any contract fails. This diagnostic suite is separate
 * from the release gate until all open findings have been resolved.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import MemoryAdapter from "../helpers/MemoryAdapter.js";
import MockTransport from "../helpers/MockTransport.js";

const [rootArg, mode = "source", output] = process.argv.slice(2);
assert(rootArg, "Pass an explicit source checkout or extracted package root");
assert(["source", "package"].includes(mode));
const root = resolve(rootArg);
const load = path => import(pathToFileURL(join(root, path)).href);
const { default: Skalex } = await load(mode === "source" ? "src/index.js" : "dist/skalex.esm.js");
const { default: FsAdapter } = await load("src/connectors/storage/fs.js");
const { default: HttpTransport } = await load("src/connectors/mcp/transports/http.js");
const make = async options => {
  const db = new Skalex({ adapter: new MemoryAdapter(), ...options });
  await db.connect();
  return db;
};
const latch = () => {
  let release;
  const promise = new Promise(r => { release = r; });
  return { promise, release };
};
const cases = [];
const check = (id, name, fn) => cases.push({ id, name, fn });

check("F01", "Valid .tmp. collection survives reconnect", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skalex-reconciliation-"));
  try {
    const db = await make({ adapter: new FsAdapter({ dir, format: "json" }) });
    await db.useCollection("orders.tmp.archive").insertOne({ _id: "saved" });
    await db.disconnect();
    const reopened = await make({ adapter: new FsAdapter({ dir, format: "json" }), logger: () => {} });
    const files = await readdir(dir);
    const doc = await reopened.useCollection("orders.tmp.archive").findOne({ _id: "saved" });
    assert.deepEqual({ filePresent: files.includes("orders.tmp.archive.json"), documentPresent: !!doc },
      { filePresent: true, documentPresent: true });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

check("F02", "MCP canonical name cannot bypass a collection deny", async () => {
  const db = await make();
  await db.useCollection("secret").insertOne({ _id: "s", value: "private" });
  const transport = new MockTransport();
  await db.mcp({ scopes: { "*": ["read", "write"], secret: [] } }).connect(transport);
  await transport.receive({ jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "skalex_find", arguments: { collection: " secret " } } });
  assert.equal(transport.lastSent().result.isError, true);
});

check("F03", "Concurrent insertOne calls cannot share an ID", async () => {
  const db = await make(); const col = db.useCollection("items");
  const results = await Promise.allSettled([col.insertOne({ _id: "same", n: 1 }), col.insertOne({ _id: "same", n: 2 })]);
  assert.deepEqual({ accepted: results.filter(r => r.status === "fulfilled").length, docs: (await col.find({})).docs.length },
    { accepted: 1, docs: 1 });
});

check("F03b", "Prepared insertMany rechecks IDs after an awaited batch hook", async () => {
  const db = await make(); const col = db.useCollection("items"); const entered = latch(); const gate = latch();
  db.use({ beforeInsert: async ({ doc }) => { if (doc._id === "hold") { entered.release(); await gate.promise; } } });
  const batch = col.insertMany([{ _id: "same", n: 1 }, { _id: "hold" }]);
  const result = batch.then(() => "accepted", e => e.code);
  await entered.promise; await col.insertOne({ _id: "same", n: 2 }); gate.release();
  assert.equal(await result, "ERR_SKALEX_UNIQUE_DUPLICATE_ID");
  assert.deepEqual((await col.find({})).docs.map(d => d._id), ["same"]);
});

check("F04a", "Unique batch transition commits consistent data and indexes", async () => {
  const db = await make(); const col = db.createCollection("items", { schema: { n: { type: "number", unique: true } } });
  await col.insertMany([{ _id: "a", n: 1 }, { _id: "b", n: 2 }]);
  let error; try { await col.updateMany({}, { n: { $inc: 1 } }); } catch (e) { error = e.code; }
  assert.deepEqual({ error, scan: (await col.find({})).docs.map(d => d.n), oldIndex: (await col.find({ n: 1 })).docs.length },
    { error: undefined, scan: [2, 3], oldIndex: 0 });
});

check("F04b", "Rejected compound-index insert leaves no ghost entries", async () => {
  const db = await make(); const col = db.createCollection("items", { indexes: ["tag", ["a", "b"]] });
  await assert.rejects(col.insertOne({ _id: "ghost", tag: "x", a: {}, b: "y" }));
  assert.deepEqual({ scan: (await col.find({})).docs.length, indexed: (await col.find({ tag: "x" })).docs.length },
    { scan: 0, indexed: 0 });
});

check("F05a", "Awaited transaction hook does not admit an unrelated write", async () => {
  const db = await make(); const col = db.useCollection("items"); const entered = latch(); const gate = latch();
  db.use({ beforeInsert: async ({ doc }) => { if (doc._id === "tx") { entered.release(); await gate.promise; } } });
  const tx = db.transaction(async t => { await t.useCollection("items").insertOne({ _id: "tx" }); throw new Error("abort"); });
  const settled = tx.catch(() => {});
  await entered.promise;
  let error; try { await col.insertOne({ _id: "outside" }); } catch (e) { error = e.code; }
  gate.release(); await settled;
  assert.equal(error, "ERR_SKALEX_TX_COLLECTION_LOCKED");
});

check("F05b", "Rollback preserves independently created collections", async () => {
  const db = await make(); db.useCollection("items"); const entered = latch(); const gate = latch();
  const tx = db.transaction(async t => { await t.useCollection("items").insertOne({ _id: "tx" }); entered.release(); await gate.promise; throw new Error("abort"); });
  const settled = tx.catch(() => {}); await entered.promise;
  await db.useCollection("outside").insertOne({ _id: "survive" });
  gate.release(); await settled;
  assert.equal(!!await db.useCollection("outside").findOne({ _id: "survive" }), true);
});

check("F05c", "Captured transaction collection expires with its transaction", async () => {
  const db = await make(); db.useCollection("items"); let col;
  await db.transaction(t => { col = t.useCollection("items"); });
  await assert.rejects(async () => col.insertOne({ _id: "stale" }), { code: "ERR_SKALEX_TX_STALE_PROXY" });
});

check("F06", "An older save cannot overwrite a completed transaction", async () => {
  const adapter = new MemoryAdapter(); const db = await make({ adapter }); const col = db.useCollection("items");
  await col.insertOne({ _id: "a", n: 0 }); await db.saveData();
  const entered = latch(); const gate = latch(); const write = adapter.write.bind(adapter); let pause = true;
  adapter.write = async (name, data) => { if (name === "items" && pause) { pause = false; entered.release(); await gate.promise; } await write(name, data); };
  const saving = db.saveData("items"); await entered.promise;
  // A correct implementation may queue the transaction behind the older save.
  const committing = db.transaction(t => t.useCollection("items").updateOne({ _id: "a" }, { n: 1 }));
  await new Promise(r => setTimeout(r, 25));
  gate.release(); await Promise.all([saving, committing]);
  const reopened = await make({ adapter });
  assert.equal((await reopened.useCollection("items").findOne({ _id: "a" })).n, 1);
});

check("F07", "Sequential partial batch is recovered or detected on reconnect", async () => {
  const adapter = new MemoryAdapter(); const db = await make({ adapter, logger: () => {} });
  for (const name of ["a", "b"]) await db.useCollection(name).insertOne({ _id: name, n: 0 });
  await db.saveData(); adapter.throwOnWrite = name => name === "b";
  await assert.rejects(db.transaction(async t => {
    await t.useCollection("a").updateOne({ _id: "a" }, { n: 1 });
    await t.useCollection("b").updateOne({ _id: "b" }, { n: 1 });
  }));
  adapter.throwOnWrite = false;
  const warnings = []; const reopened = await make({ adapter, logger: message => warnings.push(message) });
  const values = await Promise.all(["a", "b"].map(async name => (await reopened.useCollection(name).findOne({ _id: name })).n));
  assert.equal(values[0] === values[1] || warnings.some(m => /incomplete|inconsistent|recovery/i.test(m)), true,
    "Partial durable state must not load silently");
});

check("F08", "Restore cannot persist through an unrelated transaction rollback", async () => {
  const adapter = new MemoryAdapter(); const db = await make({ adapter });
  const col = db.createCollection("history", { changelog: true }); await col.insertOne({ _id: "h", value: "old" }); await db.saveData();
  const entered = latch(); const gate = latch();
  const tx = db.transaction(async t => { await t.useCollection("history").updateOne({ _id: "h" }, { value: "tx" }); entered.release(); await gate.promise; throw new Error("abort"); });
  const settled = tx.catch(() => {}); await entered.promise;
  try { await db.restore("history", new Date(0)); } catch (e) {
    assert.equal(e.code, "ERR_SKALEX_TX_COLLECTION_LOCKED");
  } finally { gate.release(); await settled; }
  const reopened = await make({ adapter });
  assert.deepEqual((await reopened.useCollection("history").find({})).docs.map(d => d.value), (await col.find({})).docs.map(d => d.value));
});

check("F09", "Failed upsertMany does not leave an unsaved partial write", async () => {
  const adapter = new MemoryAdapter(); const db = await make({ adapter, autoSave: true });
  const col = db.createCollection("items", { schema: { email: { type: "string", unique: true } } });
  await assert.rejects(col.upsertMany([{ key: "a", email: "same" }, { key: "b", email: "same" }], "key"));
  const reopened = await make({ adapter });
  // This minimum invariant allows documented partial success, but not an
  // autosaved operation leaving live state absent from persistence.
  assert.deepEqual((await col.find({})).docs.map(d => d.key), (await reopened.useCollection("items").find({})).docs.map(d => d.key));
});

check("F10", "ID operator filters agree across findOne and updateMany", async () => {
  const db = await make(); const col = db.useCollection("items"); await col.insertOne({ _id: "a", n: 0 });
  const filter = { _id: { $in: ["a"] } };
  assert.deepEqual({ find: (await col.find(filter)).docs.length, one: !!await col.findOne(filter), updated: (await col.updateMany(filter, { n: 1 })).length },
    { find: 1, one: true, updated: 1 });
});

check("F11", "HTTP rejects untrusted Origin before handler dispatch", async () => {
  const transport = new HttpTransport({ port: 0 }); let calls = 0;
  transport.onMessage(() => { calls++; return Promise.resolve(); }); await transport.start();
  try {
    // Port discovery is the only private access: no production state changes.
    const port = transport._server.address().port;
    await fetch("http://127.0.0.1:" + port + "/message", { method: "POST", headers: { Origin: "https://untrusted.example", "Content-Type": "text/plain" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
    assert.equal(calls, 0);
  } finally { await transport.stop(); }
});

check("F12", "Strict schema accepts updates with generated timestamps", async () => {
  const db = await make(); const col = db.createCollection("items", { schema: { name: "string" }, strict: true });
  await col.insertOne({ _id: "a", name: "old" });
  assert.equal((await col.updateOne({ _id: "a" }, { name: "new" })).name, "new");
});

check("F13", "Compressed memory remains semantically retrievable", async () => {
  const db = await make({ embeddingAdapter: { embed: () => Promise.resolve([1, 0]) }, llmAdapter: { summarize: () => Promise.resolve("summary") } });
  const memory = db.useMemory("session"); await memory.remember("important");
  await memory.compress({ threshold: 0, keepRecent: 0 });
  assert.equal((await memory.recall("important")).docs[0]?.text, "summary");
});

check("F14", "Projection does not remove the sort key before ordering", async () => {
  const db = await make(); const col = db.useCollection("items"); await col.insertMany([{ _id: "a", n: 2 }, { _id: "b", n: 1 }]);
  assert.deepEqual((await col.find({}, { select: ["_id"], sort: { n: 1 } })).docs.map(d => d._id), ["b", "a"]);
});

check("F15", "Missing indexed fields agree with a predicate scan", async () => {
  const db = await make(); const col = db.createCollection("items", { indexes: ["optional"] }); await col.insertOne({ _id: "a" });
  assert.equal((await col.find({ optional: undefined })).docs.length, (await col.find(d => d.optional === undefined)).docs.length);
});

check("F16", "Query results do not expose mutable stored nested values", async () => {
  const db = await make(); const col = db.useCollection("items"); await col.insertOne({ _id: "a", nested: { n: 1 } });
  const result = await col.findOne({ _id: "a" }); result.nested.n = 99;
  assert.equal((await col.findOne({ _id: "a" })).nested.n, 1);
});

const results = [];
for (const { id, name, fn } of cases) {
  try { await fn(); results.push({ id, name, status: "pass" }); }
  catch (error) { results.push({ id, name, status: "fail", code: error.code, message: error.message, actual: error.actual, expected: error.expected }); }
}
const report = { root, mode, version: JSON.parse(await readFile(join(root, "package.json"), "utf8")).version,
  runtime: process.versions, generatedAt: new Date().toISOString(), results };
if (output) { await mkdir(resolve(output, ".."), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + "\n"); }
for (const result of results) console.log(result.status.toUpperCase(), result.id, result.name);
process.exitCode = results.some(r => r.status === "fail") ? 1 : 0;
