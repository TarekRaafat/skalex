import { afterEach, describe, expect, test } from "vitest";
import Skalex from "../../src/index.js";
import MemoryAdapter from "../helpers/MemoryAdapter.js";

const databases = [];
async function collection(options) {
  const db = new Skalex({ adapter: new MemoryAdapter() });
  databases.push(db);
  await db.connect();
  return { db, col: db.createCollection("items", options) };
}
afterEach(async () => { for (const db of databases.splice(0)) await db.disconnect(); });

describe("document and secondary-index commits", () => {
  test("moves unique values across a batch without stale or missing entries", async () => {
    const { col } = await collection({ schema: { n: { type: "number", unique: true } } });
    await col.insertMany([{ _id: "a", n: 1 }, { _id: "b", n: 2 }]);
    await col.updateMany({}, { n: { $inc: 1 } });
    expect((await col.find({})).docs.map(d => [d._id, d.n])).toEqual([["a", 2], ["b", 3]]);
    expect((await col.find({ n: 1 })).docs).toEqual([]);
    expect((await col.find({ n: 2 })).docs.map(d => d._id)).toEqual(["a"]);
    expect((await col.find({ n: 3 })).docs.map(d => d._id)).toEqual(["b"]);
    await expect(col.insertOne({ n: 2 })).rejects.toMatchObject({ code: "ERR_SKALEX_UNIQUE_VIOLATION" });
  });

  test.each(["insertOne", "insertMany"])("%s rejects invalid compound values without ghost index entries", async method => {
    const { col } = await collection({ indexes: ["n", ["a", "b"]] });
    const invalid = { _id: "bad", n: 2, a: {}, b: 1 };
    const write = method === "insertOne" ? col.insertOne(invalid) : col.insertMany([{ _id: "good", n: 1, a: 1, b: 1 }, invalid]);
    await expect(write).rejects.toMatchObject({ code: "ERR_SKALEX_VALIDATION_COMPOUND_INDEX" });
    expect((await col.find({})).docs).toEqual([]);
    expect((await col.find({ n: 1 })).docs).toEqual([]);
    expect((await col.find({ n: 2 })).docs).toEqual([]);
    await col.insertOne({ _id: "bad", n: 2, a: 2, b: 1 });
    expect((await col.find({ n: 2 })).docs).toHaveLength(1);
  });

  test.each(["updateOne", "updateMany"])("%s leaves documents and all indexes unchanged on invalid candidates", async method => {
    const { col } = await collection({ indexes: ["n", ["a", "b"]] });
    await col.insertMany([{ _id: "a", n: 1, a: 1, b: 1 }, { _id: "b", n: 2, a: 2, b: 1 }]);
    const before = (await col.find({})).docs;
    await expect(col[method]({}, { n: 3, a: {} })).rejects.toMatchObject({ code: "ERR_SKALEX_VALIDATION_COMPOUND_INDEX" });
    expect((await col.find({})).docs).toEqual(before);
    expect((await col.find({ n: 3 })).docs).toEqual([]);
    expect((await col.find({ n: 1 })).docs.map(d => d._id)).toEqual(["a"]);
    expect((await col.find({ a: 2, b: 1 })).docs.map(d => d._id)).toEqual(["b"]);
  });

  test("a beforeUpdate hook removing a target cannot leave earlier targets partially updated", async () => {
    const { db, col } = await collection({});
    await col.insertMany([{ _id: "a", n: 1 }, { _id: "b", n: 2 }]);
    db.use({ beforeUpdate: async () => { await col.deleteOne({ _id: "b" }); } });
    await expect(col.updateMany({}, { n: 3 })).rejects.toMatchObject({ code: "ERR_SKALEX_PERSISTENCE_DOC_MISSING" });
    expect((await col.find({})).docs.map(d => [d._id, d.n])).toEqual([["a", 1]]);
  });
});
