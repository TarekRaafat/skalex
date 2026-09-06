/**
 * Download and verify the exact alpha.6 npm artifact without running scripts.
 * Usage: bun tests/reconciliation/fetch-release.mjs <empty-evidence-directory>
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";

const dir = resolve(process.argv[2] || "/tmp/skalex-alpha6-evidence");
await mkdir(dir, { recursive: true });
const response = await fetch("https://registry.npmjs.org/skalex/4.0.0-alpha.6");
assert(response.ok, "npm metadata request failed");
const metadata = await response.json();
assert.equal(metadata.version, "4.0.0-alpha.6");
assert.equal(new URL(metadata.dist.tarball).origin, "https://registry.npmjs.org");
const archive = await fetch(metadata.dist.tarball);
assert(archive.ok, "npm tarball request failed");
const bytes = Buffer.from(await archive.arrayBuffer());
const integrity = "sha512-" + createHash("sha512").update(bytes).digest("base64");
assert.equal(integrity, metadata.dist.integrity, "npm tarball integrity mismatch");
const path = join(dir, "alpha.6.tgz");
await writeFile(path, bytes);
const entries = execFileSync("tar", ["-tzf", path], { encoding: "utf8" }).trim().split("\n");
assert(entries.every(entry => entry.startsWith("package/") && !entry.split("/").includes("..")), "Unsafe archive path");
execFileSync("tar", ["-xzf", path, "-C", dir]);
await writeFile(join(dir, "registry.json"), JSON.stringify({
  version: metadata.version, gitHead: metadata.gitHead, tarball: metadata.dist.tarball,
  integrity, verifiedAt: new Date().toISOString(),
}, null, 2) + "\n");
console.log(join(dir, "package"));
