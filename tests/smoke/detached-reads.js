/** Check opt-in detached reads and unchanged shallow defaults. */
export default async function detachedReads(db, assert) {
  const col = db.useCollection("detached_reads");
  await col.insertOne({ _id: "a", nested: { n: 1 } });
  const detached = await col.findOne({ _id: "a" }, { clone: true });
  detached.nested.n = 9;
  assert("cloned read cannot mutate stored nested data", (await col.findOne({ _id: "a" })).nested.n === 1);
  const first = await col.findOne({ _id: "a" });
  const second = await col.findOne({ _id: "a" });
  assert("default reads retain shallow references", first.nested === second.nested);
  await col.insertOne({ _id: "function", fn: () => 1 });
  let code;
  try { await col.findOne({ _id: "function" }, { clone: true }); } catch (error) { code = error.code; }
  assert("clone failure has a typed code", code === "ERR_SKALEX_QUERY_CLONE");
  await col.deleteOne({ _id: "function" });
}
