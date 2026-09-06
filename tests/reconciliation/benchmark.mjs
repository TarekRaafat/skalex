/**
 * Alternating before/after measurements for unindexed, unique, and compound indexes.
 * Usage: bun tests/reconciliation/benchmark.mjs <baseline-root> <fixed-root> <output> [none|unique|compound|all]
 */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import MemoryAdapter from "../helpers/MemoryAdapter.js";
const [beforeRoot, afterRoot, output, profile = "all"] = process.argv.slice(2);
assert(beforeRoot && afterRoot && output, "Pass baseline, fixed source, and output paths");
assert(["none", "unique", "compound", "all"].includes(profile), "Unknown benchmark profile");
const variants = {};
for (const [name, root] of Object.entries({ before: beforeRoot, after: afterRoot })) {
  variants[name] = (await import(pathToFileURL(resolve(root, "src/index.js")))).default;
}
const profiles = profile === "all" ? ["none", "unique", "compound"] : [profile];
const workloads = {};
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
for (const workload of profiles) {
  const samples = { before: [], after: [] };
  for (let round = 0; round < 12; round++) {
    for (const name of round % 2 ? ["after", "before"] : ["before", "after"]) {
      const db = new variants[name]({ adapter: new MemoryAdapter() });
      await db.connect();
      try {
        const options = workload === "unique" ? { schema: { n: { type: "number", unique: true } } }
          : workload === "compound" ? { indexes: [["group", "n"]] } : {};
        const col = db.createCollection("bench", options);
        let start = performance.now();
        for (let i = 0; i < 10000; i++) await col.insertOne({ _id: String(i), n: i, group: "g" });
        const insertMs = performance.now() - start;
        start = performance.now();
        let found = 0;
        for (let i = 0; i < 1000; i++) {
          const filter = workload === "none" ? { _id: String(i) }
            : workload === "unique" ? { n: i } : { group: "g", n: i };
          if ((await col.findOne(filter))?._id === String(i)) found++;
        }
        const findMs = performance.now() - start;
        assert.equal(found, 1000, "Every lookup must find the intended document");
        let compoundFindMs;
        if (workload === "compound") {
          start = performance.now();
          let compoundFound = 0;
          for (let i = 0; i < 1000; i++) {
            const result = await col.find({ group: "g", n: i }, { limit: 1 });
            if (result.docs[0]?._id === String(i)) compoundFound++;
          }
          compoundFindMs = performance.now() - start;
          assert.equal(compoundFound, 1000, "Compound-index lookups must find the intended document");
        }
        start = performance.now();
        for (let i = 0; i < 1000; i++) {
          await col.updateOne({ _id: String(i) }, { n: { $inc: 10000 } });
        }
        const updateMs = performance.now() - start;
        assert.equal((await col.findOne({ _id: "999" })).n, 10999);
        if (round >= 3) samples[name].push({ insertMs, findMs, updateMs, ...(workload === "compound" ? { compoundFindMs } : {}) });
      } finally { await db.disconnect(); }
    }
  }
  const medians = {};
  for (const name of Object.keys(samples)) {
    medians[name] = Object.fromEntries(["insertMs", "findMs", "updateMs", ...(workload === "compound" ? ["compoundFindMs"] : [])].map(key =>
      [key, median(samples[name].map(s => s[key]))]
    ));
  }
  workloads[workload] = { lookup: "findMs measures findOne; compoundFindMs separately measures find with a compound-index filter", medians, samples };
  console.log(workload, JSON.stringify(medians));
}
const report = {
  runtime: process.versions, beforeRoot, afterRoot,
  counts: { insert: 10000, find: 1000, update: 1000 }, warmupRounds: 3, measuredRounds: 9,
  conditions: "No persistence during timed operations; single-document updates move unique values into an unoccupied range; alternating variant order.",
  workloads,
};
await writeFile(output, JSON.stringify(report, null, 2) + "\n");
