import { afterEach, expect, test } from "vitest";
import IndexEngine from "../../src/engine/indexes.js";
import Skalex from "../../src/index.js";
import MemoryAdapter from "../helpers/MemoryAdapter.js";
import expectIndexMatchesScan from "../helpers/expectIndexMatchesScan.js";

const databases = [];
async function setup(kind, extra = {}) {
  const db = new Skalex({ adapter: new MemoryAdapter() });
  databases.push(db);
  await db.connect();
  const options = kind === "unique" ? { schema: { optional: { type: "any", unique: true } }, indexes: ["group"] }
    : { indexes: kind === "compound" ? [["optional", "group"], "optional", "group"] : ["optional", "group"] };
  const col = db.createCollection("items", { ...options, ...extra });
  await col.insertMany([
    { _id: "a", group: "x", n: 1 },
    { _id: "b", optional: undefined, group: "x", n: 2 },
    { _id: "c", optional: null, group: "x", n: 3 },
    { _id: "d", optional: 7, group: "x", n: 4 },
    { _id: "e", group: "y", n: 5 },
  ]);
  return { db, col };
}
afterEach(async () => { await Promise.all(databases.splice(0).map(db => db.disconnect())); });

for (const kind of ["regular", "unique", "compound"]) {
  test(kind + " index agrees with scan for missing, null and defined fields", async () => {
    const { col } = await setup(kind);
    for (const value of [undefined, null, 7, 99]) await expectIndexMatchesScan(col, "optional", value);
    await expectIndexMatchesScan(col, { optional: undefined, group: "x" });
    await expectIndexMatchesScan(col, { group: "x", optional: undefined });
    expect((await col.find({ optional: undefined })).docs.map(d => d._id)).toEqual(["a", "b", "e"]);
    expect((await col.findOne({ optional: undefined }))?._id).toBe("a");
    expect(await col.count({ optional: undefined })).toBe(3);
    expect(await col.sum("n", { optional: undefined })).toBe(8);
  });

  test(kind + " updateMany matches missing-field candidates", async () => {
    const { col } = await setup(kind);
    const updated = await col.updateMany({ optional: undefined }, { n: 9 });
    expect(updated.map(d => d._id)).toEqual(["a", "b", "e"]);
    expect((await col.findOne({ _id: "c" })).n).toBe(3);
    await expectIndexMatchesScan(col, "optional", undefined);
  });

  test(kind + " updateOne and upsert reuse a matching missing-field document", async () => {
    const { col } = await setup(kind);
    expect((await col.updateOne({ optional: undefined }, { n: 8 }))._id).toBe("a");
    expect((await col.upsert({ optional: undefined }, { n: 9 }))._id).toBe("a");
    expect(await col.count()).toBe(5);
  });

  test(kind + " deleteMany removes missing fields without deleting null", async () => {
    const { col } = await setup(kind);
    expect((await col.deleteMany({ optional: undefined })).map(d => d._id)).toEqual(["a", "b", "e"]);
    expect((await col.find({})).docs.map(d => d._id)).toEqual(["c", "d"]);
  });

  test(kind + " index remains consistent across transitions and reconnect", async () => {
    const { db, col } = await setup(kind);
    await col.updateOne({ _id: "a" }, { optional: 8 });
    await col.updateOne({ _id: "d" }, { optional: undefined });
    await expectIndexMatchesScan(col, "optional", undefined);
    await expectIndexMatchesScan(col, "optional", 8);
    await db.saveData();
    await db.disconnect();
    await db.connect();
    await expectIndexMatchesScan(db.useCollection("items"), "optional", undefined);
  });
}

test("soft-deleted missing fields obey visibility and restore filters", async () => {
  const { col } = await setup("regular", { softDelete: true });
  await col.deleteOne({ _id: "a" });
  expect((await col.find({ optional: undefined })).docs.map(d => d._id)).toEqual(["b", "e"]);
  expect((await col.find({ optional: undefined }, { includeDeleted: true })).docs.map(d => d._id)).toEqual(["a", "b", "e"]);
  await col.restore({ optional: undefined });
  expect((await col.findOne({ optional: undefined }))?._id).toBe("a");
});

test("operator and logical filters retain missing-field matching", async () => {
  const { col } = await setup("regular");
  for (const filter of [{ optional: { $eq: undefined } }, { $and: [{ optional: undefined }] }, { optional: { $in: [undefined] } }]) {
    expect((await col.find(filter)).docs.map(d => d._id)).toEqual(["a", "b", "e"]);
  }
});

test.each(["lookup", "_lookupIterable"])("%s requests fallback for unrepresented undefined values", method => {
  for (const index of [new IndexEngine(["optional"]), new IndexEngine([], ["optional"])]) {
    index.add({ _id: "a" });
    expect(index[method]("optional", undefined)).toBeNull();
    expect([...index[method]("optional", 99)]).toEqual([]);
  }
});
