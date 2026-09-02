#!/usr/bin/env node
// Presence guard for the esnext.disposable lib reference. Zero dependencies.
//
// src/index.d.ts declares `[Symbol.asyncDispose](): Promise<void>` to support
// `await using db = new Skalex(...)`. That symbol lives in lib.esnext.disposable
// (TS 5.2+), so a consumer whose tsconfig targets `lib: ES2022` or earlier would
// hit TS2550 reading our declaration file - unless we pull the lib in ourselves
// with a triple-slash `/// <reference lib="esnext.disposable" />` directive.
//
// The zero-dependency rule forbids a devDependency on `typescript`, so we cannot
// run a tsc-based check here. This guard instead asserts the directive is still
// present, which catches the realistic regression: someone deleting or
// reordering it during a refactor (triple-slash directives are only honored at
// the very top of the file, before any statement). The alpha.6 simulated-consumer
// install remains the spec-by-example backstop for subtler TS behavior changes.
//
// Wired into the mandatory gate via `npm run verify`.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DTS = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.d.ts");
const DIRECTIVE = /^\/\/\/\s*<reference\s+lib=["']esnext\.disposable["']\s*\/>/m;

const source = readFileSync(DTS, "utf8");

// The directive is only effective at the top of the file: TypeScript treats a
// triple-slash reference that follows a statement as a plain comment. Assert it
// appears before the first non-comment, non-blank line.
const lines = source.split("\n");
let firstCodeLine = -1;
for (let i = 0; i < lines.length; i++) {
  const t = lines[i].trim();
  if (t === "" || t.startsWith("//")) continue;
  firstCodeLine = i;
  break;
}
const header = firstCodeLine === -1 ? source : lines.slice(0, firstCodeLine).join("\n");

if (!DIRECTIVE.test(header)) {
  console.error(
    "verify:lib-ref FAIL - src/index.d.ts is missing the top-of-file directive\n" +
      '  /// <reference lib="esnext.disposable" />\n\n' +
      "Without it, consumers targeting lib: ES2022 or earlier get TS2550 on\n" +
      "Symbol.asyncDispose. Restore it as the first line of src/index.d.ts (before\n" +
      "any statement - a triple-slash reference after code is treated as a comment).",
  );
  process.exit(1);
}

console.log("verify:lib-ref ok - esnext.disposable reference present at top of src/index.d.ts");
