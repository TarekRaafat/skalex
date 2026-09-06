/** Verify missing-field index fallback against built artifacts. */
export default async function missingIndexFields(db, assert) {
  const col = db.createCollection("missing_index_fields", { indexes: ["optional"] });
  await col.insertMany([{ _id: "a" }, { _id: "b", optional: null }]);
  assert("indexed find matches missing fields", (await col.find({ optional: undefined })).docs[0]?._id === "a");
  assert("indexed findOne matches missing fields", (await col.findOne({ optional: undefined }))?._id === "a");
  const updated = await col.updateMany({ optional: undefined }, { changed: true });
  assert("indexed mutation matches missing fields", updated.length === 1 && updated[0]._id === "a");
}
