/**
 * Diagnose the bounded commit-stage recovery contract using one-shot faults.
 * Run: bun tests/reconciliation/index-faults.mjs <source-root> <output.json>
 * Exits nonzero when an injected index failure leaves inconsistent live state.
 * Faults are simulated internal exceptions, not evidence of a natural trigger.
 */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import MemoryAdapter from "../helpers/MemoryAdapter.js";

const [root, output] = process.argv.slice(2);
assert(root && output, "Pass a source root and output path");
const { default: Skalex } = await import(pathToFileURL(resolve(root, "src/index.js")));
const { default: IndexEngine } = await import(pathToFileURL(resolve(root, "src/engine/indexes.js")));
const results = [];
for (const scenario of [
  { method: "insertOne", phase: "after-index-add", target: "_indexDoc", hit: 1 },
  { method: "insertMany", phase: "after-second-index-add", target: "_indexDoc", hit: 2 },
  { method: "updateOne", phase: "after-index-add", target: "_indexDoc", hit: 1 },
  { method: "updateMany", phase: "after-first-index-removal", target: "remove", hit: 1 },
  { method: "updateMany", phase: "after-second-index-add", target: "_indexDoc", hit: 2 },
]) {
  const db = new Skalex({ adapter: new MemoryAdapter() });
  await db.connect();
  const col = db.createCollection("items", {
    schema: { n: { type: "number", unique: true } }, indexes: [["n", "group"]],
  });
  await col.insertMany([{ _id: "a", n: 1, group: "g" }, { _id: "b", n: 2, group: "g" }]);
  const before = (await col.find({})).docs;
  const original = IndexEngine.prototype[scenario.target];
  const fault = new TypeError("Injected one-shot index commit failure");
  let calls = 0, observed;
  IndexEngine.prototype[scenario.target] = function (...args) {
    const result = original.apply(this, args);
    if (++calls === scenario.hit) throw fault;
    return result;
  };
  try {
    if (scenario.method === "insertOne") await col.insertOne({ _id: "c", n: 3, group: "g" });
    else if (scenario.method === "insertMany") await col.insertMany([{ _id: "c", n: 3, group: "g" }, { _id: "d", n: 4, group: "g" }]);
    else await col[scenario.method]({}, { n: { $inc: 10 } });
  } catch (error) { observed = error; }
  finally { IndexEngine.prototype[scenario.target] = original; }
  try {
    assert.equal(observed, fault, "The intended commit-stage fault must fire");
    const scan = (await col.find({})).docs;
    assert.deepEqual(scan, before, "Rejected mutation must preserve stored documents");
    for (const n of [1, 2, 3, 4, 11, 12]) {
      const expected = scan.filter(doc => doc.n === n);
      assert.deepEqual((await col.find({ n })).docs, expected, "Unique index must match scan for " + n);
      assert.deepEqual((await col.find({ n, group: "g" })).docs, expected, "Compound index must match scan for " + n);
    }
    results.push({ ...scenario, status: "pass" });
  } catch (error) {
    results.push({ ...scenario, status: "fail", message: error.message });
  } finally { await db.disconnect(); }
}
const report = { sourceRoot: resolve(root), runtime: process.versions, failureModel: "One synchronous index operation throws once, after changing index state; subsequent operations can run normally.", results };
await writeFile(output, JSON.stringify(report, null, 2) + "\n");
for (const item of results) console.log(item.status.toUpperCase(), item.method, item.phase);
if (results.some(item => item.status === "fail")) process.exitCode = 1;
