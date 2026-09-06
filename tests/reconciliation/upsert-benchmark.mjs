/**
 * Measure successful upsertMany batches before and after a source change.
 * Run: bun tests/reconciliation/upsert-benchmark.mjs <before-root> <after-root> <output.json>
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
const results = {};
for (const workload of ["insert", "update", "mixed"]) {
  const samples = { before: [], after: [] };
  for (let round = 0; round < 12; round++) {
    for (const label of round % 2 ? ["after", "before"] : ["before", "after"]) {
      const db = new variants[label]({ adapter: new MemoryAdapter() });
      await db.connect();
      try {
        const col = db.createCollection("items", { indexes: ["sku"] });
        const input = Array.from({ length: 10000 }, (_, i) => ({ _id: String(i), sku: String(i), n: 1 }));
        const seed = workload === "insert" ? [] : workload === "update" ? input : input.filter((_, i) => i % 2 === 0);
        if (seed.length) await col.insertMany(seed.map(doc => ({ ...doc, n: 0 })));
        const batches = Array.from({ length: 100 }, (_, i) => input.slice(i * 100, (i + 1) * 100));
        const start = performance.now();
        for (const batch of batches) await col.upsertMany(batch, "sku");
        const elapsed = performance.now() - start;
        const docs = (await col.find({})).docs;
        assert.equal(docs.length, 10000);
        assert(docs.every(doc => doc.n === 1));
        if (round >= 3) samples[label].push(elapsed);
      } finally { await db.disconnect(); }
    }
  }
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const medians = { before: median(samples.before), after: median(samples.after) };
  results[workload] = { medians, samples };
  console.log(workload, JSON.stringify(medians));
}
await writeFile(output, JSON.stringify({
  beforeRoot, afterRoot, runtime: process.versions,
  conditions: "100 batches of 100 documents; indexed sku; no timed persistence or changelog; three warmup and nine measured alternating rounds",
  results,
}, null, 2) + "\n");
