/**
 * Compare saved writes and transaction commits across source revisions.
 * Run: bun tests/reconciliation/save-order-benchmark.mjs <before> <after> <output>
 */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";
import MemoryAdapter from "../helpers/MemoryAdapter.js";
const [before, after, output] = process.argv.slice(2);
assert(before && after && output);
const variants = {};
for (const [label, root] of Object.entries({ before, after })) {
  variants[label] = (await import(pathToFileURL(resolve(root, "src/index.js")))).default;
}
const workloads = {};
for (const workload of ["savedUpdate", "transaction", "parallelSaves"]) {
  const samples = { before: [], after: [] };
  for (let round = 0; round < 12; round++) {
    for (const label of round % 2 ? ["after", "before"] : ["before", "after"]) {
      const db = new variants[label]({ adapter: new MemoryAdapter() });
      await db.connect();
      for (const name of ["a", "b", "c"]) await db.useCollection(name).insertOne({ _id: "x", n: 0 }, { save: true });
      const col = db.useCollection("a");
      const start = performance.now();
      for (let n = 1; n <= 100; n++) {
        if (workload === "savedUpdate") await col.updateOne({ _id: "x" }, { n }, { save: true });
        else if (workload === "transaction") await db.transaction(tx => tx.useCollection("a").updateOne({ _id: "x" }, { n }));
        else await Promise.all(["a", "b", "c"].map(name => db.saveData(name)));
      }
      const elapsed = performance.now() - start;
      if (round >= 3) samples[label].push(elapsed);
      assert.equal((await col.findOne({ _id: "x" })).n, workload === "parallelSaves" ? 0 : 100);
      await db.disconnect();
    }
  }
  workloads[workload] = { samples };
}
await writeFile(output, JSON.stringify({
  runtime: process.versions.bun, before, after, warmupRounds: 3, measuredRounds: 9,
  conditions: "Milliseconds per 100 operations, three one-document collections, MemoryAdapter, alternating variants.",
  workloads,
}, null, 2) + "\n");
