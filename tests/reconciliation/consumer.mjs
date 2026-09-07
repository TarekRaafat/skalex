/**
 * Verify an installed tarball and alpha.6 storage compatibility without publishing.
 * Build and pack first with bun run build and bun pm pack --ignore-scripts.
 * Run: bun tests/reconciliation/consumer.mjs <candidate.tgz> <alpha.6.tgz> <output.json>
 * Uses the existing tsd TypeScript compiler. Adds no dependencies.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const [candidateArg, baselineArg, outputArg] = process.argv.slice(2);
assert(candidateArg && baselineArg && outputArg, "Pass candidate tarball, verified alpha.6 tarball and output path");
const candidate = resolve(candidateArg), baseline = resolve(baselineArg), output = resolve(outputArg);
const root = fileURLToPath(new URL("../../", import.meta.url));
const baselineIntegrity = "I9rZXQiVfNe64DNIFejrbnqTOmSZAQ50qBj4sV3WJEyErFbi5T+euPS6b/pc20em1Jgcs75j9kMT9DKelVLsww==";
assert.equal(createHash("sha512").update(readFileSync(baseline)).digest("base64"), baselineIntegrity);
const workspace = mkdtempSync(join(tmpdir(), "skalex-consumer-"));
const results = [];
const run = (command, args, cwd = workspace) => execFileSync(command, args, { cwd, encoding: "utf8", timeout: 120000 });
try {
  const old = join(workspace, "baseline");
  mkdirSync(old);
  run("tar", ["-xzf", baseline, "-C", old]);
  writeFileSync(join(workspace, "package.json"), JSON.stringify({ private: true, type: "module", dependencies: { skalex: candidate } }));
  run("bun", ["install", "--ignore-scripts", "--no-progress"]);
  const installed = join(workspace, "node_modules/skalex");
  const pkg = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  assert.deepEqual(readdirSync(join(workspace, "node_modules")).filter(name => !name.startsWith(".")), ["skalex"]);
  const files = run("tar", ["-tzf", candidate]).trim().split("\n");
  assert(!files.some(file => /(?:^|\/)(?:FINDINGS\.md|AGENTS\.md|tests|design|agent_docs)(?:\/|$)/.test(file)));
  for (const entry of Object.values(pkg.exports)) for (const target of Object.values(entry)) readFileSync(join(installed, target));
  writeFileSync(join(workspace, "consumer.mjs"), `
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import Skalex from "skalex";
import { FsAdapter, EncryptedAdapter } from "skalex/connectors/storage";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync("node_modules/skalex/package.json", "utf8"));
for (const key of Object.keys(pkg.exports)) await import(key === "." ? "skalex" : "skalex" + key.slice(1));
for (const key of ["skalex", "skalex/min"]) {
  const mod = require(key);
  const Common = mod.default ?? mod;
  assert.equal(typeof Common.prototype.connect, "function");
  const db = new Common({ adapter: new FsAdapter({ dir: resolve("data", key.replace("/", "-")) }) });
  await db.connect();
  await db.useCollection("items").insertOne({ _id: "cjs", n: 1 });
  await db.useCollection("items").updateOne({ _id: "cjs" }, { n: 2 });
  assert.equal((await db.useCollection("items").findOne({ _id: "cjs" })).n, 2);
  await db.useCollection("items").deleteOne({ _id: "cjs" });
  assert.equal(await db.useCollection("items").findOne({ _id: "cjs" }), null);
  await db.disconnect();
}
const oldRoot = process.argv[2];
const { default: Old } = await import(pathToFileURL(resolve(oldRoot, "dist/skalex.esm.js")));
const { default: OldFs } = await import(pathToFileURL(resolve(oldRoot, "src/connectors/storage/fs.js")));
const { default: OldEncrypted } = await import(pathToFileURL(resolve(oldRoot, "src/connectors/storage/encrypted.js")));
for (const format of ["json", "gz"]) for (const encrypted of [false, true]) {
  const dir = resolve("data", format + encrypted);
  const adapter = (F, E) => encrypted ? new E(new F({ dir, format }), "ab".repeat(32)) : new F({ dir, format });
  const old = new Old({ adapter: adapter(OldFs, OldEncrypted) });
  await old.connect();
  const col = old.createCollection("orders", { indexes: ["n"] });
  await col.insertOne({ _id: "saved", n: 1, date: new Date("2020-01-01"), bigint: 123n,
    nested: { value: 7 }, __skalex_bigint__: "ordinary text" });
  await old.disconnect();
  const db = new Skalex({ adapter: adapter(FsAdapter, EncryptedAdapter) });
  await db.connect();
  const current = db.useCollection("orders");
  const loaded = await current.findOne({ n: 1 });
  assert.equal(loaded._id, "saved");
  assert.equal(loaded.date.toISOString(), "2020-01-01T00:00:00.000Z");
  assert.equal(loaded.bigint, 123n);
  assert.equal(loaded.__skalex_bigint__, "ordinary text");
  const copy = await current.findOne({ _id: "saved" }, { clone: true });
  copy.nested.value = 99;
  assert.equal((await current.findOne({ _id: "saved" })).nested.value, 7);
  await db.transaction(async tx => { await tx.useCollection("orders").updateOne({ _id: "saved" }, { n: 2 }); });
  const mcp = db.mcp({ transport: "http", port: 0 });
  try {
    await mcp.listen();
    const response = await fetch(mcp.url, { headers: { Origin: "https://untrusted.example" } });
    assert.equal(response.status, 403);
  } finally { await mcp.close(); }
  await db.disconnect();
  await db.connect();
  const saved = await db.useCollection("orders").findOne({ n: 2 });
  assert.equal(saved.bigint, 123n);
  assert.equal(saved.date.toISOString(), "2020-01-01T00:00:00.000Z");
  assert.equal(saved.nested.value, 7);
  await db.disconnect();
}
console.log("PASS installed exports, CJS CRUD, HTTP loading and four alpha.6 storage migrations");
`);
  for (const runtime of ["node", "bun"]) {
    results.push({ runtime, output: run(runtime, ["consumer.mjs", join(old, "package")]).trim() });
    rmSync(join(workspace, "data"), { recursive: true, force: true });
  }
  writeFileSync(join(workspace, "consumer.ts"), `
import Skalex from "skalex";
import FsAdapter from "skalex/connectors/fs";
import { EncryptedAdapter } from "skalex/connectors/storage";
const db = new Skalex({ adapter: new EncryptedAdapter(new FsAdapter({ dir: "/unused" }), "ab".repeat(32)) });
async function check() {
  const col = db.useCollection<{ n: number }>("orders");
  const doc = await col.findOne({}, { clone: true });
  const n: number | undefined = doc?.n;
  await db.transaction(async tx => {
    await tx.useCollection("orders").insertOne({ n });
    // @ts-expect-error Persistence is unavailable through the transaction handle.
    await tx.saveData();
  });
  await db.acknowledgeIncompleteFlush();
  await db[Symbol.asyncDispose]();
}
void check;
`);
  const compiler = join(root, "node_modules/@tsd/typescript/typescript/bin/tsc");
  for (const lib of ["ES2022", "ES2024"]) for (const mode of ["NodeNext", "Bundler"]) {
    const config = { compilerOptions: { strict: true, noEmit: true, skipLibCheck: false, types: [],
      target: "ES2022", lib: [lib, "DOM"], module: mode === "NodeNext" ? "NodeNext" : "ESNext", moduleResolution: mode },
      files: ["consumer.ts"] };
    writeFileSync(join(workspace, "tsconfig.json"), JSON.stringify(config));
    run("bun", [compiler, "-p", "tsconfig.json"]);
    results.push({ types: lib, resolution: mode, passed: true });
  }
  // Prove the ES2022 consumer checks detect loss of the disposal library reference.
  for (const file of ["dist/skalex.d.ts", "src/index.d.ts"]) {
    const path = join(installed, file);
    writeFileSync(path, readFileSync(path, "utf8").replace('/// <reference lib="esnext.disposable" />', ""));
  }
  const configPath = join(workspace, "tsconfig.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.compilerOptions.lib = ["ES2022", "DOM"];
  writeFileSync(configPath, JSON.stringify(config));
  let negative;
  try { run("bun", [compiler, "-p", "tsconfig.json"]); }
  catch (error) { negative = error; }
  assert(negative, "Removing the library reference must fail consumer compilation");
  assert.match(String(negative.stdout), /asyncDispose/);
  results.push({ types: "ES2022 without disposal reference", rejected: true });
  const report = { candidateVersion: pkg.version, candidateSha256: createHash("sha256").update(readFileSync(candidate)).digest("hex"),
    baselineVersion: "4.0.0-alpha.6", baselineIntegrity: "sha512-" + baselineIntegrity,
    packageFiles: files.length, runtimeDependencies: 0, results,
    limits: "Version shown is installed tarball metadata; publication is not verified. CJS checks exercise CRUD; migration and HTTP exercises use ESM. Tests cover JSON/gz with and without encryption, not every adapter or minimum Node version. Built-browser/Deno smoke is a separate gate." };
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} finally { rmSync(workspace, { recursive: true, force: true }); }
