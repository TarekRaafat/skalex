/** Check strict schema updates against built artifacts. */
export default async function strictTimestamps(db, assert) {
  const col = db.createCollection("strict_timestamps", { schema: { n: "number" }, strict: true });
  const before = await col.insertOne({ _id: "a", n: 1 });
  await col.updateOne({ _id: "a" }, { n: 2 });
  const after = await col.findOne({ _id: "a" });
  assert("strict update accepts generated timestamps", after.n === 2 && after.updatedAt instanceof Date);
  assert("strict update preserves creation time", +after.createdAt === +before.createdAt);
  let code;
  try { await col.updateOne({ _id: "a" }, { extra: true }); } catch (error) { code = error.code; }
  assert("strict update rejects unknown user fields", code === "ERR_SKALEX_VALIDATION_UPDATE");
}
