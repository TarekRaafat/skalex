/**
 * scripts/run-deno.js
 *
 * Locates the deno binary and executes it with the given arguments.
 * Works correctly on macOS, Linux, and Windows whether invoked via
 * npm, bun, pnpm, or yarn (those runners don't always expand $HOME).
 *
 * Usage (via package.json script):
 *   node scripts/run-deno.js tests/smoke/deno.test.js
 */

import { execFileSync } from "node:child_process";
import { join }         from "node:path";
import { homedir }      from "node:os";

const win     = process.platform === "win32";
const bin     = win ? "deno.exe" : "deno";
const home    = homedir();

// Platform-specific candidate paths, most likely first.
const candidates = win
  ? [
      join(home, ".deno", "bin", bin),          // default installer location
      join(home, "AppData", "Local", "deno", bin), // alternative Windows path
      bin,                                       // PATH fallback (bare name)
    ]
  : [
      join(home, ".deno", "bin", bin),           // default installer (Mac + Linux)
      "/usr/local/bin/deno",                     // system-wide install
      "/opt/homebrew/bin/deno",                  // Homebrew on macOS (Intel + Apple Silicon)
      "/home/linuxbrew/.linuxbrew/bin/deno",     // Homebrew on Linux
      "/snap/bin/deno",                          // Snap (Ubuntu/Debian)
      bin,                                       // PATH fallback (bare name)
    ];

const deno = candidates.find(candidate => {
  try {
    execFileSync(candidate, ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
});

if (!deno) {
  console.error("Error: deno binary not found.");
  console.error("Install from https://deno.com or add it to your PATH.");
  process.exit(1);
}

execFileSync(deno, process.argv.slice(2), { stdio: "inherit" });
