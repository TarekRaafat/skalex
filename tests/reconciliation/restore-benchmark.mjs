/**
 * Compare historical restore throughput across two source revisions.
 * Run: bun tests/reconciliation/restore-benchmark.mjs <before-root> <after-root> <output.json>
 */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import MemoryAdapter from "../helpers/MemoryAdapter.js";
const [beforeRoot, afterRoot, output] = process.argv.slice(2);
assert(beforeRoot && afterRoot && output);
const variants = {};
for (const [label, root] of Object.entries({ before: beforeRoot, after: afterRoot })) {
  variants[label] = (await import(pathToFileURL(resolve(root, "src/index.js")))).default;
}
const workloads = {};
for (const mode of ["one", "all"]) {
  const samples = { before: [], after: [] };
  for (let round = 0; round < 12; round++) {
    for (const label of round % 2 ? ["after", "before"] : ["before", "after"]) {
      const db = new variants[label]({ adapter: new MemoryAdapter() });
      await db.connect();
      const col = db.createCollection("items", { changelog: true, indexes: ["n"] });
      await col.insertMany(Array.from({ length: 100 }, (_, n) => ({ _id: String(n), n, nested: { n } })));
      const timestamp = new Date("2100-01-01");
      const options = mode === "one" ? { _id: "0" } : {};
      const start = performance.now();
      for (let i = 0; i < 100; i++) await db.restore("items", timestamp, options);
      const elapsed = performance.now() - start;
      assert.equal(await col.count(), 100);
      assert.equal((await db.changelog().query("items")).length, 100);
      assert.equal((await col.findOne({ _id: "0" })).nested.n, 0);
      if (round >= 3) samples[label].push(elapsed);
      await db.disconnect();
    }
  }
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const medians = { before: median(samples.before), after: median(samples.after) };
  workloads[mode] = { samples, medians };
  console.log(mode, JSON.stringify(medians));
}
await writeFile(output, JSON.stringify({
  runtime: process.versions.bun, beforeRoot, afterRoot, warmupRounds: 3, measuredRounds: 9,
  conditions: "100 restores per sample, 100 archived documents, regular index, MemoryAdapter; milliseconds.",
  workloads,
}, null, 2) + "\n");
