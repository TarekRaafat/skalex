import { describe, expect, test } from "vitest";
import Skalex from "../../src/index.js";
import MemoryAdapter from "../helpers/MemoryAdapter.js";

async function setup(indexed = false, options = {}) {
  const db = new Skalex({ adapter: new MemoryAdapter() });
  await db.connect();
  const col = db.createCollection("items", { indexes: indexed ? ["group"] : [], ...options });
  await col.insertMany([
    { _id: "a", n: 1, group: "odd" },
    { _id: "b", n: 2, group: "even" },
    { _id: "c", n: 3, group: "odd" },
  ]);
  return { db, col };
}
const cases = [
  ["in", { _id: { $in: ["a", "c"] } }, ["a", "c"]],
  ["eq", { _id: { $eq: "b" } }, ["b"]],
  ["ne", { _id: { $ne: "b" } }, ["a", "c"]],
  ["nin", { _id: { $nin: ["a", "b"] } }, ["c"]],
  ["range", { _id: { $gte: "b", $lt: "d" } }, ["b", "c"]],
  ["regexp", { _id: /^[ac]$/ }, ["a", "c"]],
  ["regex operator", { _id: { $regex: "^[ac]$" } }, ["a", "c"]],
  ["predicate operator", { _id: { $fn: id => id === "b" } }, ["b"]],
  ["empty in", { _id: { $in: [] } }, []],
  ["additional field", { _id: { $in: ["a", "b"] }, group: "even" }, ["b"]],
  ["literal with mismatch", { _id: "a", group: "even" }, []],
  ["literal", { _id: "c" }, ["c"]],
];
describe.each([false, true])("ID filter equivalence with secondary index=%s", indexed => {
  test.each(cases)("%s agrees across reads and aggregates", async (_name, filter, ids) => {
    const { col } = await setup(indexed);
    const scanned = (await col.find({})).docs.filter(doc => ids.includes(doc._id));
    expect((await col.find(filter)).docs).toEqual(scanned);
    expect(await col.findOne(filter)).toEqual(scanned[0] ?? null);
    expect(await col.count(filter)).toBe(scanned.length);
    expect(await col.sum("n", filter)).toBe(scanned.reduce((sum, doc) => sum + doc.n, 0));
    if (scanned.length) expect(await col.avg("n", filter)).toBe(scanned.reduce((sum, doc) => sum + doc.n, 0) / scanned.length);
  });
});

test.each(["updateOne", "updateMany", "upsert", "deleteOne", "deleteMany"])("%s applies ID operators to the intended documents", async method => {
  const { col } = await setup();
  const filter = { _id: { $in: ["a", "c"] } };
  const removing = method.startsWith("delete");
  const result = removing ? await col[method](filter) : await col[method](filter, { n: 9 });
  const expected = method.endsWith("Many") ? ["a", "c"] : ["a"];
  expect((Array.isArray(result) ? result : [result]).map(doc => doc?._id)).toEqual(expected);
  const all = (await col.find({})).docs;
  if (removing) expect(all.map(doc => doc._id)).toEqual(["a", "b", "c"].filter(id => !expected.includes(id)));
  else {
    expect(all).toHaveLength(3);
    expect(all.filter(doc => doc.n === 9).map(doc => doc._id)).toEqual(expected);
  }
});

test("ID operators preserve soft-delete visibility and restoration", async () => {
  const { col } = await setup(false, { softDelete: true });
  await col.deleteOne({ _id: "a" });
  const filter = { _id: { $in: ["a", "c"] } };
  expect((await col.findOne(filter))._id).toBe("c");
  expect(await col.count(filter)).toBe(1);
  expect((await col.findOne(filter, { includeDeleted: true }))._id).toBe("a");
  await col.restore({ _id: { $eq: "a" } });
  expect((await col.findOne(filter))._id).toBe("a");
});

test.each(["", 0, false, 7])("literal ID %s retains matcher semantics", async id => {
  const { col } = await setup();
  await col.insertOne({ _id: id, n: 4 });
  expect((await col.findOne({ _id: id }))._id).toBe(id);
  expect(await col.count({ _id: id })).toBe(1);
});

test("null and empty filters still select the first visible document", async () => {
  const { col } = await setup();
  for (const filter of [null, undefined, {}]) expect((await col.findOne(filter))._id).toBe("a");
});
