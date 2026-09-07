/** Check recovery after a one-shot synchronous index mutation failure. */
export default async function commitRecovery(db, assert) {
  const col = db.createCollection("commit_recovery", { schema: { n: { type: "number", unique: true } } });
  await col.insertMany([{ _id: "a", n: 1 }, { _id: "b", n: 2 }]);
  const original = col._fieldIndex._indexDoc;
  const fault = new TypeError("one-shot commit fault");
  let calls = 0, observed;
  col._fieldIndex._indexDoc = function (...args) {
    const result = original.apply(this, args);
    if (++calls === 2) throw fault;
    return result;
  };
  try { await col.updateMany({}, { n: { $inc: 10 } }); }
  catch (error) { observed = error; }
  finally { col._fieldIndex._indexDoc = original; }
  assert("commit recovery rethrows original error", observed === fault);
  assert("commit recovery restores scan order and values", (await col.find({})).docs.map(doc => doc.n).join(",") === "1,2");
  assert("commit recovery restores unique index", (await col.findOne({ n: 1 }))?._id === "a");
  assert("commit recovery removes failed index value", await col.findOne({ n: 12 }) === null);
  await col.updateOne({ _id: "a" }, { n: 3 });
  assert("writes resume after successful recovery", (await col.findOne({ n: 3 }))?._id === "a");
}
