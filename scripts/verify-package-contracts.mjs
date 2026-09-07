import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
const root = process.argv[2] || ".";
const { default: EncryptedAdapter } = await import(pathToFileURL(resolve(root, "src/connectors/storage/encrypted.js")));

const require = createRequire(import.meta.url);
const expected = ["AdapterError", "Collection", "PersistenceError", "QueryError", "SkalexError", "TransactionError", "UniqueConstraintError", "ValidationError", "default"];
const entries = ["skalex.esm.js", "skalex.esm.min.js", "skalex.browser.js", "skalex.cjs", "skalex.min.cjs"];
let canonical;
for (const name of entries) {
  const path = resolve(root, "dist", name);
  const mod = name.endsWith(".cjs") ? require(path) : await import(pathToFileURL(path));
  const exports = typeof mod === "function" ? { default: mod, ...mod } : mod;
  if (!name.endsWith(".cjs")) assert.deepEqual(Object.keys(exports).sort(), expected, name);
  const ErrorType = exports.AdapterError;
  canonical ??= ErrorType;
  assert.equal(ErrorType, canonical, name + " constructor identity");
  assert.equal(new ErrorType("TEST", "test").name, "AdapterError");
  assert.throws(() => new EncryptedAdapter({}, new Uint8Array(1)), error =>
    error instanceof ErrorType && error instanceof exports.SkalexError &&
    !(error instanceof exports.QueryError) && error.code === "ERR_SKALEX_ADAPTER_INVALID_KEY");
  const db = new exports.default({ adapter: { list: async () => [], write: async () => {}, read: async () => null } });
  const replies = [];
  const server = db.mcp();
  let receive;
  await server.connect({ onMessage: callback => { receive = callback; }, send: reply => { replies.push(reply); } });
  await receive({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert(replies[0].result.tools.some(tool => tool.name === "skalex_find"), name + " lazy tools");
  await server.close();
}
console.log("PASS packaged entry exports, shared error constructors and lazy MCP tools");

if (!process.argv[2]) {
  for (const file of ["src/connectors/mcp/tools.js", "src/engine/errors.js"]) {
    assert.equal(readFileSync("docs/" + file, "utf8"), readFileSync(file, "utf8"), "documentation module parity");
  }
  assert.equal(readFileSync("docs/lib/skalex.browser.js", "utf8"), readFileSync("dist/skalex.browser.js", "utf8"), "documentation bundle parity");
}
