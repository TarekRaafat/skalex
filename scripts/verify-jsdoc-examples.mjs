#!/usr/bin/env node
// Check JavaScript snippets in JSDoc without executing examples or adding dependencies.
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = [];
function collect(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) collect(path);
    else if (/\.(?:js|ts)$/.test(path)) files.push(path);
  }
}
collect(join(root, "src"));
collect(join(root, "tests/helpers"));
let checked = 0;
for (const file of files) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(/\/\*\*([\s\S]*?)\*\//g)) {
    const text = match[1].split("\n").map(line => line.replace(/^\s*\* ?/, "")).join("\n").trim();
    const snippets = [];
    // Explicit examples can span blank lines and stop at the next JSDoc tag.
    for (const example of text.matchAll(/@example\s*([\s\S]*?)(?=\n\s*@\w+|$)/g)) {
      snippets.push(example[1].replace(/^```(?:js|javascript)?\s*\n|\n```\s*$/g, "").trim());
    }
    // Older usage blocks have no @example tag. Check code paragraphs separately.
    if (!text.includes("@example")) {
      for (const paragraph of text.split(/\n\s*\n/)) {
        const code = paragraph.trim();
        if (/^(?:import |export |const |let |await |db\.)/.test(code)) snippets.push(code);
      }
    }
    for (const snippet of snippets) {
      if (!snippet) continue;
      // Illustrative object placeholders are not executable JavaScript.
      const code = snippet.replace(/\{\s*\.\.\.\s*\}/g, "{}");
      const result = spawnSync("node", ["--input-type=module", "--check"], {
        input: code, encoding: "utf8", timeout: 10000,
      });
      if (result.status !== 0) {
        throw new Error("Invalid JSDoc example in " + file + "\n" + code + "\n" + (result.stderr || result.error));
      }
      checked++;
    }
  }
}
console.log("Verified " + checked + " JSDoc code examples");
