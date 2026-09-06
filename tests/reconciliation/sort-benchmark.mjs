/**
 * Compare find workloads across revisions.
 * Usage: bun tests/reconciliation/sort-benchmark.mjs <before> <after> <output>
 */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";
import MemoryAdapter from "../helpers/MemoryAdapter.js";
const [before, after, output] = process.argv.slice(2);
assert(before && after && output);
const variants = {};
for (const [name, root] of Object.entries({ before, after })) variants[name] = (await import(pathToFileURL(resolve(root, "src/index.js")))).default;
const samples = { before: [], after: [] };
for (let round = 0; round < 12; round++) {
  for (const name of round % 2 ? ["after", "before"] : ["before", "after"]) {
    const db = new variants[name]({ adapter: new MemoryAdapter() });
    try {
      const col = db.useCollection("benchmark");
      await col.insertMany(Array.from({ length: 1000 }, (_, i) => ({ _id: String(i), rank: 1000 - i, text: "entry " + i })));
      const sample = {};
      for (const [key, options] of Object.entries({
        sorted: { sort: { rank: 1 }, limit: 25 },
        projected: { sort: { rank: 1 }, select: ["_id"], limit: 25 },
        limited: { select: ["_id"], limit: 25 },
        full: {},
      })) {
        const start = performance.now();
        for (let i = 0; i < 100; i++) {
          const result = await col.find({}, options);
          assert.equal(result.docs.length, key === "full" ? 1000 : 25);
        }
        sample[key] = performance.now() - start;
      }
      if (round >= 3) samples[name].push(sample);
    } finally { await db.disconnect(); }
  }
}
await writeFile(output, JSON.stringify({ before, after, runtime: process.versions.bun, conditions: "100 queries per workload over 1000 docs, page size 25; 3 warmup and 9 measured alternating pairs; baseline projected sort is incorrect", samples }, null, 2) + "\n");
