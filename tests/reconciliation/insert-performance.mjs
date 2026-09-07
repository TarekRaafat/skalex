/**
 * Compare baseline, pre-optimization and optimized built ESM inserts.
 * Usage: bun tests/reconciliation/insert-performance.mjs <baseline-entry> <before-entry> <after-entry> <output>
 * Use node --expose-gc for the Node comparison. Timings exclude connection and persistence.
 */
import { pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";
import MemoryAdapter from "../helpers/MemoryAdapter.js";
import assert from "node:assert/strict";
const [baselineEntry, beforeEntry, afterEntry, output] = process.argv.slice(2);
assert(baselineEntry && beforeEntry && afterEntry && output, "Pass three built ESM entry paths and an output path");
const roots = { alpha6: baselineEntry, alpha7: beforeEntry, optimized: afterEntry };
assert(globalThis.Bun?.gc || globalThis.gc, "Garbage collection control is required. Use Bun or node --expose-gc.");
const variants = Object.fromEntries(await Promise.all(Object.entries(roots).map(async ([n,p])=>[n,(await import(pathToFileURL(p))).default])));
const median = x=>[...x].sort((a,b)=>a-b)[Math.floor(x.length/2)];
const report = {entries:roots, runtime:process.version, bun:process.versions.bun, count:30000, warmups:5, rounds:11, conditions:"Built ESM, explicit IDs, MemoryAdapter, no timed persistence, rotating variant order, full GC before each sample",profiles:{}};
for(const profile of ["none","unique","compound"]) {
 const samples = Object.fromEntries(Object.keys(variants).map(n=>[n,[]]));
 for(let r=0;r<16;r++) {
 const names=Object.keys(variants); const order=[...names.slice(r%3),...names.slice(0,r%3)];
 for(const name of order) {
 if(globalThis.Bun) globalThis.Bun.gc(true); else globalThis.gc();
 const db=new variants[name]({adapter:new MemoryAdapter()}); await db.connect();
 const opts=profile==="unique"?{schema:{n:{type:"number",unique:true}}}:profile==="compound"?{indexes:[["group","n"]]}:{};
 const col=db.createCollection("bench",opts);
 const start=performance.now();
 for(let i=0;i<30000;i++) await col.insertOne({_id:String(i),n:i,group:"g"});
 const ms=performance.now()-start;
 assert.equal((await col.findOne({_id:"29999"})).n,29999);
 if(r>=5) samples[name].push(ms);
 await db.disconnect();
 }
 }
 report.profiles[profile]={medians:Object.fromEntries(Object.entries(samples).map(([n,v])=>[n,median(v)])),samples};
 console.log(profile,JSON.stringify(report.profiles[profile].medians));
}
await writeFile(output,JSON.stringify(report,null,2)+"\n");
