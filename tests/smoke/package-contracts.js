import EncryptedAdapter from "../../src/connectors/storage/encrypted.js";
import MemoryAdapter from "../helpers/MemoryAdapter.js";

/** Verify package identity and lifecycle safety through each built runtime entry. */
export default async function packageContracts(parent, assert) {
  const db = new parent.constructor({ adapter: new MemoryAdapter(), logger: () => {} });
  let error;
  try { new EncryptedAdapter({}, new Uint8Array(1)); } catch (caught) { error = caught; }
  assert("connector errors share the root error hierarchy", error instanceof db.constructor.AdapterError && error instanceof db.constructor.SkalexError);
  assert("error subclasses remain distinct", !(error instanceof db.constructor.QueryError));
  const server = db.mcp();
  let receive;
  const replies = [];
  await server.connect({ onMessage: fn => { receive = fn; }, send: reply => { replies.push(reply); } });
  await receive({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert("lazy MCP tools load", replies[0]?.result?.tools.some(tool => tool.name === "skalex_find"));
  const col = db.createCollection("constructor");
  await col.insertOne({ value: 0 }, { save: true });
  await receive({ jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "skalex_find", arguments: { collection: "constructor" } } });
  assert("MCP scopes use own collection rules", !replies[1]?.result?.isError &&
    JSON.parse(replies[1].result.content[0].text).docs.length === 1);
  await server.close();
  await db.transaction(async tx => {
    await tx.useCollection("constructor").updateOne({}, { value: 1 });
    let code;
    try { await db.saveData("constructor"); } catch (caught) { code = caught.code; }
    assert("ordinary saves reject locked collections", code === "ERR_SKALEX_TX_COLLECTION_LOCKED");
  });
  await db.disconnect();
  await db.connect();
  let code;
  try { await col.insertOne({ value: 2 }); } catch (caught) { code = caught.code; }
  assert("retained disconnected handles reject", code === "ERR_SKALEX_VALIDATION_STALE_COLLECTION");
  assert("current store retains only committed data", await db.useCollection("constructor").count() === 1);
  await db.disconnect();
}
