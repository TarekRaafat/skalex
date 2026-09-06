import { afterEach, expect, test } from "vitest";
import Skalex from "../../src/index.js";
import MemoryAdapter from "../helpers/MemoryAdapter.js";

const databases = [];
async function setup() {
  const db = new Skalex({ adapter: new MemoryAdapter(), embeddingAdapter: { embed: () => Promise.resolve([1, 0]) } });
  databases.push(db);
  await db.connect();
  const col = db.useCollection("items");
  await col.insertMany([
    { _id: "a", group: "x", nested: { n: 1 }, list: [{ n: 1 }], _vector: [1, 0] },
    { _id: "b", group: "x", nested: { n: 2 }, list: [{ n: 2 }], _vector: [1, 0] },
  ]);
  return { db, col };
}
afterEach(async () => { await Promise.all(databases.splice(0).map(db => db.disconnect())); });

const reads = {
  findOne: async col => [await col.findOne({ _id: "a" }, { clone: true })],
  find: async col => (await col.find({}, { clone: true, sort: { _id: 1 } })).docs,
  search: async col => (await col.search("query", { clone: true })).docs,
  similar: async col => (await col.similar("b", { clone: true })).docs,
  groupBy: async col => (await col.groupBy("group", {}, { clone: true })).x,
};
for (const [name, read] of Object.entries(reads)) {
  test(name + " detaches nested objects, arrays and timestamps", async () => {
    const { col } = await setup();
    const docs = await read(col);
    const id = docs[0]._id;
    const before = structuredClone(await col.findOne({ _id: id }));
    const created = +before.createdAt;
    docs[0].nested.n = 99;
    docs[0].list[0].n = 99;
    docs[0].createdAt.setTime(0);
    const stored = await col.findOne({ _id: id });
    expect(stored.nested.n).toBe(before.nested.n);
    expect(stored.list[0].n).toBe(before.list[0].n);
    expect(+stored.createdAt).toBe(created);
  });
}

test.each([undefined, false])("clone=%s retains the existing shallow read contract", async clone => {
  const { col } = await setup();
  const a = await col.findOne({ _id: "a" }, { clone });
  const b = await col.findOne({ _id: "a" });
  expect(a).not.toBe(b);
  expect(a.nested).toBe(b.nested);
});

test("projected populated results detach nested related documents", async () => {
  const { db, col } = await setup();
  await db.useCollection("authors").insertOne({ _id: "writer", nested: { n: 3 } });
  await col.updateOne({ _id: "a" }, { authors: "writer" });
  for (const method of ["find", "findOne"]) {
    const result = await col[method]({ _id: "a" }, { select: ["authors"], populate: ["authors"], clone: true });
    const doc = method === "find" ? result.docs[0] : result;
    expect(Object.keys(doc)).toEqual(["authors"]);
    doc.authors.nested.n = 99;
    expect((await db.useCollection("authors").findOne({ _id: "writer" })).nested.n).toBe(3);
  }
});

test("cloning happens after projection so excluded functions do not fail", async () => {
  const { col } = await setup();
  await col.insertOne({ _id: "fn", nested: { n: 1 }, fn: () => 1 });
  expect(await col.findOne({ _id: "fn" }, { select: ["nested"], clone: true })).toEqual({ nested: { n: 1 } });
  await col.deleteOne({ _id: "fn" });
});

test.each(["findOne", "find", "search", "similar", "groupBy"])("%s reports a typed clone failure", async method => {
  const { col } = await setup();
  await col.insertOne({ _id: "fn", group: "x", fn: () => 1, _vector: [1, 0] });
  const action = method === "findOne" ? col.findOne({ _id: "fn" }, { clone: true })
    : method === "find" ? col.find({}, { clone: true })
      : method === "search" ? col.search("query", { clone: true })
        : method === "similar" ? col.similar("a", { clone: true })
          : col.groupBy("group", {}, { clone: true });
  await expect(action).rejects.toMatchObject({ name: "QueryError", code: "ERR_SKALEX_QUERY_CLONE" });
  await col.deleteOne({ _id: "fn" });
});

test("empty and paginated results retain their shapes", async () => {
  const { col } = await setup();
  expect(await col.findOne({ _id: "missing" }, { clone: true })).toBeNull();
  expect(await col.find({ _id: "missing" }, { clone: true })).toEqual({ docs: [] });
  expect(await col.find({}, { clone: true, select: ["_id"], sort: { _id: 1 }, limit: 1 })).toEqual({ docs: [{ _id: "a" }], page: 1, totalDocs: 2, totalPages: 2 });
  expect(await col.similar("missing", { clone: true })).toEqual({ docs: [], scores: [] });
});

test("read cloning supports Maps, Sets, typed arrays and cycles", async () => {
  const { col } = await setup();
  const cyclic = { n: 1 }; cyclic.self = cyclic;
  await col.insertOne({ _id: "types", map: new Map([["a", { n: 1 }]]), set: new Set([1]), bytes: new Uint8Array([1]), cyclic });
  const result = await col.findOne({ _id: "types" }, { clone: true });
  result.map.get("a").n = 9; result.set.add(2); result.bytes[0] = 9; result.cyclic.n = 9;
  const stored = await col.findOne({ _id: "types" });
  expect(stored.map.get("a").n).toBe(1);
  expect(stored.set.size).toBe(1);
  expect(stored.bytes[0]).toBe(1);
  expect(stored.cyclic.n).toBe(1);
  expect(result.cyclic.self).toBe(result.cyclic);
  await col.deleteOne({ _id: "types" });
});

test("memory history and recall propagate clone", async () => {
  const { db } = await setup();
  const memory = db.useMemory("detached");
  await memory.remember("hello");
  for (const doc of [(await memory.history({ clone: true }))[0], (await memory.recall("hello", { clone: true })).docs[0]]) doc.createdAt.setTime(0);
  expect(+(await memory.history())[0].createdAt).not.toBe(0);
});

test("transaction collection handles support detached reads", async () => {
  const { db, col } = await setup();
  await db.transaction(async tx => {
    const result = await tx.useCollection("items").findOne({ _id: "a" }, { clone: true });
    result.nested.n = 99;
  });
  expect((await col.findOne({ _id: "a" })).nested.n).toBe(1);
});

test("afterFind additions are cloned before the result leaves the method", async () => {
  const { db, col } = await setup();
  const extra = { n: 1 };
  db.use({ afterFind: ({ docs }) => { for (const doc of docs) doc.extra = extra; } });
  const result = await col.find({}, { clone: true });
  result.docs[0].extra.n = 9;
  expect(extra.n).toBe(1);
});
