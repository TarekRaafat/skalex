/** Check ID operator matching against the runtime's built database. */
export default async function idFilters(db, assert) {
  const col = db.createCollection("id_filters");
  await col.insertMany([{ _id: "a", n: 1 }, { _id: "b", n: 2 }, { _id: "c", n: 3 }]);
  const filter = { _id: { $in: ["a", "c"] } };
  assert("findOne matches ID operators", (await col.findOne(filter))?._id === "a");
  assert("count matches ID operators", await col.count(filter) === 2);
  assert("ID regex matches", (await col.findOne({ _id: /^c$/ }))?._id === "c");
  const updated = await col.updateMany(filter, { n: 9 });
  assert("updateMany matches both ID candidates", updated.length === 2);
  assert("literal ID lookup retains extra conditions", await col.findOne({ _id: "b", n: 9 }) === null);
}
