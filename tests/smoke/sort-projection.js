/** Verify sorting on an omitted field through built artifacts. */
export default async function sortProjection(db, assert) {
  const col = db.useCollection("sort_projection");
  await col.insertMany([{ _id: "a", rank: 2 }, { _id: "b", rank: 1 }]);
  const result = await col.find({}, { select: ["_id"], sort: { rank: 1 }, limit: 1 });
  assert("hidden sort key determines returned page", result.docs[0]?._id === "b");
  assert("projection hides the sort key", !("rank" in result.docs[0]));
  assert("sorted pagination retains totals", result.totalDocs === 2 && result.totalPages === 2);
}
