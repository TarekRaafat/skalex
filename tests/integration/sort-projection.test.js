import { afterEach, expect, test } from "vitest";
import Skalex from "../../src/index.js";
import MemoryAdapter from "../helpers/MemoryAdapter.js";

const databases = [];
async function setup(indexed = false) {
  const db = new Skalex({ adapter: new MemoryAdapter() });
  databases.push(db);
  await db.connect();
  const col = db.createCollection("items", { indexes: indexed ? ["group"] : [] });
  await col.insertMany([
    { _id: "a", n: 3, group: "x", label: "third", date: new Date("2024-03-01"), _vector: [1, 0] },
    { _id: "b", n: 1, group: "x", label: "first", date: new Date("2024-01-01"), _vector: [1, 0] },
    { _id: "c", n: 2, group: "x", label: "second", date: new Date("2024-02-01"), _vector: [1, 0] },
    { _id: "d", n: 1, group: "x", label: "tie", date: new Date("2024-01-01"), _vector: [1, 0] },
  ]);
  return { db, col };
}
afterEach(async () => { await Promise.all(databases.splice(0).map(db => db.disconnect())); });

for (const indexed of [false, true]) {
  test.each([{ n: 1 }, { n: -1 }, { n: 1, label: -1 }, { date: 1 }])("projection preserves sort %j with indexed=" + indexed, async sort => {
    const { col } = await setup(indexed);
    const filter = { group: "x" };
    const full = await col.find(filter, { sort });
    const projected = await col.find(filter, { sort, select: ["_id"] });
    expect(projected.docs).toEqual(full.docs.map(doc => ({ _id: doc._id })));
    expect((await col.find({})).docs.map(doc => doc._id)).toEqual(["a", "b", "c", "d"]);
  });
}

test("ascending ties preserve matching insertion order", async () => {
  const { col } = await setup();
  expect((await col.find({}, { sort: { n: 1 }, select: ["_id"] })).docs).toEqual(["b", "d", "c", "a"].map(_id => ({ _id })));
});

test.each([1, 2, 3])("sort before projection and pagination produces page %s and correct totals", async page => {
  const { col } = await setup();
  const full = await col.find({}, { sort: { n: 1 }, page, limit: 2 });
  const projected = await col.find({}, { sort: { n: 1 }, select: ["label"], page, limit: 2 });
  expect(projected).toEqual({ ...full, docs: full.docs.map(({ label }) => ({ label })) });
});

test("empty projection returns only empty documents with correct pagination", async () => {
  const { col } = await setup();
  expect(await col.find({}, { sort: { n: 1 }, select: [], limit: 2 })).toEqual({ docs: [{}, {}], page: 1, totalDocs: 4, totalPages: 2 });
});

test("unsorted limit-only fast path retains insertion order and omitted totals", async () => {
  const { col } = await setup();
  expect(await col.find({}, { select: ["_id"], limit: 2 })).toEqual({ docs: [{ _id: "a" }, { _id: "b" }], page: 1 });
});

test("population uses stored foreign keys for sorting and returns the selected page", async () => {
  const { db } = await setup();
  await db.useCollection("authors").insertMany([{ _id: "z", name: "Z" }, { _id: "a", name: "A" }]);
  const posts = db.useCollection("posts");
  await posts.insertMany([{ _id: "p1", authors: "z" }, { _id: "p2", authors: "a" }]);
  const result = await posts.find({}, { sort: { authors: 1 }, select: ["_id"], populate: ["authors"], limit: 1 });
  expect(result.docs[0]).toMatchObject({ _id: "p2", authors: { _id: "a", name: "A" } });
  expect(result.totalDocs).toBe(2);
});

test("afterFind sees only projected sorted output and returned copies protect top-level fields", async () => {
  const { db, col } = await setup();
  let observed;
  db.use({ afterFind: ({ docs }) => { observed = docs.map(doc => ({ ...doc })); } });
  const result = await col.find({}, { sort: { n: 1 }, select: ["_id", "_vector"] });
  expect(observed).toEqual(["b", "d", "c", "a"].map(_id => ({ _id })));
  result.docs[0]._id = "changed";
  expect((await col.findOne({ _id: "b" }))._id).toBe("b");
});
