/**
 * Compare compression with deterministic local model adapters.
 * Usage: bun tests/reconciliation/memory-benchmark.mjs <before> <after> <output>
 */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";
import MemoryAdapter from "../helpers/MemoryAdapter.js";
const [before, after, output] = process.argv.slice(2);
assert(before && after && output);
const variants = {};
for (const [name, root] of Object.entries({ before, after })) {
  variants[name] = (await import(pathToFileURL(resolve(root, "src/index.js")))).default;
}
const samples = { before: [], after: [] };
for (let round = 0; round < 12; round++) {
  for (const name of round % 2 ? ["after", "before"] : ["before", "after"]) {
    let embeds = 0;
    const db = new variants[name]({
      adapter: new MemoryAdapter(),
      embeddingAdapter: { embed: () => { embeds++; return Promise.resolve([1, 0]); } },
      llmAdapter: { summarize: () => Promise.resolve("summary") },
    });
    try {
      const memory = db.useMemory("benchmark");
      for (let i = 0; i < 100; i++) await memory.remember("memory " + i);
      embeds = 0;
      const start = performance.now();
      await memory.compress({ threshold: 0, keepRecent: 10 });
      const ms = performance.now() - start;
      assert.equal((await memory.history()).length, 11);
      if (round >= 3) samples[name].push({ ms, embeds });
    } finally { await db.disconnect(); }
  }
}
await writeFile(output, JSON.stringify({ before, after, runtime: process.versions.bun, conditions: "100 entries, keep 10, autoSave false, deterministic local embedding/LLM; setup excluded; 3 warmup and 9 measured alternating pairs", samples }, null, 2) + "\n");
