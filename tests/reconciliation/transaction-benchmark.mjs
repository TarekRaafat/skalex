/**
 * Compare transaction setup and owned-write throughput on two source revisions.
 * Run: bun tests/reconciliation/transaction-benchmark.mjs <before-root> <after-root> <output.json>
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
const counts = { empty: [1000, 0], single: [1000, 1], batch: [100, 100] };
const workloads = {};
for (const [workload, [transactions, writes]] of Object.entries(counts)) {
  const samples = { before: [], after: [] };
  for (let round = 0; round < 12; round++) {
    for (const label of round % 2 ? ["after", "before"] : ["before", "after"]) {
      const db = new variants[label]({ adapter: new MemoryAdapter() });
      await db.connect();
      try {
        const col = db.useCollection("items");
        await col.insertOne({ _id: "x", n: 0 });
        const started = performance.now();
        for (let i = 0; i < transactions; i++) {
          await db.transaction(async tx => {
            if (!writes) return;
            const owned = tx.useCollection("items");
            for (let j = 0; j < writes; j++) {
              await owned.updateOne({ _id: "x" }, { n: { $inc: 1 } });
            }
          });
        }
        const elapsed = performance.now() - started;
        assert.equal((await col.findOne({ _id: "x" })).n, transactions * writes);
        if (round >= 3) samples[label].push(elapsed);
      } finally {
        await db.disconnect();
      }
    }
  }
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const medians = { before: median(samples.before), after: median(samples.after) };
  workloads[workload] = { transactions, writesPerTransaction: writes, samples, medians };
  console.log(workload, JSON.stringify(medians));
}
await writeFile(output, JSON.stringify({
  runtime: process.versions.bun, beforeRoot, afterRoot, warmupRounds: 3, measuredRounds: 9,
  conditions: "Alternating variants; one stored document; MemoryAdapter commit; milliseconds.",
  workloads,
}, null, 2) + "\n");
