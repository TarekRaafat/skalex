/**
 * Browser smoke test runner — headless Chromium via Playwright.
 *
 * Serves the project root as a static site, opens browser.html in a
 * headless browser, waits for all assertions to finish, then reports
 * results in the same format as the other smoke tests.
 *
 * Run:
 *   npm run smoke:browser
 *
 * First-time setup (once):
 *   npx playwright install chromium
 *
 * Exit 0 = all checks passed.
 * Exit 1 = one or more checks failed.
 */

import { chromium } from "playwright";
import { createServer } from "http";
import { readFileSync, existsSync } from "fs";
import { extname, join, resolve } from "path";
import { fileURLToPath } from "url";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");

// ─── Static file server ───────────────────────────────────────────────────────

const MIME = {
  ".html": "text/html",
  ".js":   "application/javascript",
  ".mjs":  "application/javascript",
  ".cjs":  "application/javascript",
  ".json": "application/json",
  ".map":  "application/json",
  ".ts":   "text/plain",
};

function startServer() {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const filePath = join(ROOT, decodeURIComponent(req.url.split("?")[0]));
      if (existsSync(filePath)) {
        const ext = extname(filePath);
        res.writeHead(200, { "Content-Type": MIME[ext] ?? "text/plain" });
        res.end(readFileSync(filePath));
      } else {
        res.writeHead(404);
        res.end("Not found: " + req.url);
      }
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
    server.on("error", reject);
  });
}

// ─── Page runner ─────────────────────────────────────────────────────────────

async function runPage(page, port, path, label) {
  await page.goto(`http://127.0.0.1:${port}/${path}`);

  await page.waitForFunction(
    () => !document.getElementById("info")?.textContent.includes("Running"),
    { timeout: 30_000 }
  );

  const result = await page.evaluate(() => {
    const lines  = [...document.getElementById("output").children]
      .map(el => el.textContent);
    const info   = document.getElementById("info").textContent;
    const match  = info.match(/(\d+) passed.*?(\d+) failed/);
    const passed = match ? parseInt(match[1], 10) : 0;
    const failed = match ? parseInt(match[2], 10) : 0;
    const ua     = navigator.userAgent
      .match(/(Chrome|Firefox|Safari|Edg)\/[\d.]+/)?.[0] ?? "Chromium";
    return { lines, passed, failed, ua };
  });

  console.log(`\n${label}`);
  result.lines.forEach(l => console.log(l));
  console.log("\n" + "─".repeat(50));
  console.log(`${result.ua} — ${label}`);
  console.log(`Passed: ${result.passed}  Failed: ${result.failed}`);
  console.log("─".repeat(50));

  return result;
}

// ─── Runner ───────────────────────────────────────────────────────────────────

async function run() {
  const server  = await startServer();
  const { port } = server.address();
  const browser = await chromium.launch();

  // Mirror browser console errors to the terminal
  function attachListeners(page) {
    page.on("console", msg => {
      if (msg.type() === "error") console.error("  [browser console]", msg.text());
    });
    page.on("pageerror", err => {
      console.error("  [page error]", err.message);
    });
  }

  let totalFailed = 0;

  try {
    // ── ESM browser build (skalex.browser.js) ──────────────────────────────
    const page1 = await browser.newPage();
    attachListeners(page1);
    const r1 = await runPage(page1, port, "tests/smoke/browser.html", "browser ESM build (skalex.browser.js)");
    await page1.close();
    totalFailed += r1.failed;

    // ── UMD / CDN build (skalex.umd.min.js) ────────────────────────────────
    const page2 = await browser.newPage();
    attachListeners(page2);
    const r2 = await runPage(page2, port, "tests/smoke/browser-umd.html", "browser UMD build (skalex.umd.min.js) — CDN path");
    await page2.close();
    totalFailed += r2.failed;

  } finally {
    await browser.close();
    server.close();
  }

  if (totalFailed > 0) process.exit(1);
}

run().catch(err => {
  console.error("\nUnhandled error:", err);
  process.exit(1);
});
