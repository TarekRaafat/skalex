import { afterEach, expect, test, vi } from "vitest";
import Skalex from "../../src/index.js";
import IndexEngine from "../../src/engine/indexes.js";
import DataStore from "../../src/engine/datastore.js";
import MemoryAdapter from "../helpers/MemoryAdapter.js";
import expectIndexMatchesScan from "../helpers/expectIndexMatchesScan.js";

const databases = [];
async function setup(options = {}) {
  const adapter = new MemoryAdapter();
  const db = new Skalex({ adapter, autoSave: true });
  databases.push(db);
  await db.connect();
  const col = db.createCollection("items", { schema: { n: { type: "number", unique: true } }, indexes: ["group", ["n", "group"]], ...options });
  await col.insertMany([{ _id: "a", n: 1, group: "g" }, { _id: "b", n: 2, group: "g" }]);
  return { db, col, adapter };
}
afterEach(async () => { await Promise.all(databases.splice(0).map(db => db.disconnect())); });

async function inject(Class, method, hit, action) {
  const original = Class.prototype[method];
  const fault = new TypeError("one-shot commit failure");
  let calls = 0;
  Class.prototype[method] = function (...args) {
    const result = original.apply(this, args);
    if (++calls === hit) throw fault;
    return result;
  };
  try { await expect(action()).rejects.toBe(fault); }
  finally { Class.prototype[method] = original; }
}

async function expectRestored(col, before) {
  expect((await col.find({})).docs).toEqual(before);
  for (const n of [1, 2, 3, 4, 11, 12]) {
    await expectIndexMatchesScan(col, "n", n);
    await expectIndexMatchesScan(col, { n, group: "g" });
  }
  for (const id of ["a", "b", "c", "d"]) expect(await col.findOne({ _id: id })).toEqual(before.find(doc => doc._id === id) ?? null);
}
const cases = [
  ["insertOne", IndexEngine, "_indexDoc", 1],
  ["insertMany", IndexEngine, "_indexDoc", 2],
  ["updateOne", IndexEngine, "_indexDoc", 1],
  ["updateMany", IndexEngine, "remove", 1],
  ["updateMany", IndexEngine, "_indexDoc", 2],
  ["insertOne", DataStore, "push", 1],
  ["insertMany", DataStore, "push", 1],
  ["updateOne", DataStore, "replaceAt", 1],
  ["updateMany", DataStore, "replaceAt", 2],
  ["deleteOne", IndexEngine, "remove", 1],
  ["deleteOne", DataStore, "spliceAt", 1],
  ["deleteMany", IndexEngine, "remove", 2],
  ["deleteMany", DataStore, "replaceAll", 1],
];
for (const [method, Class, target, hit] of cases) {
  test(method + " recovers after " + Class.name + "." + target + " hit " + hit, async () => {
    const { db, col, adapter } = await setup();
    const before = structuredClone((await col.find({})).docs);
    const persisted = await adapter.read("items");
    const events = [];
    const unwatch = col.watch(event => events.push(event));
    const action = () => method === "insertOne" ? col.insertOne({ _id: "c", n: 3, group: "g" })
      : method === "insertMany" ? col.insertMany([{ _id: "c", n: 3, group: "g" }, { _id: "d", n: 4, group: "g" }])
        : method.startsWith("update") ? col[method]({}, { n: { $inc: 10 } })
          : col[method]({});
    await inject(Class, target, hit, action);
    unwatch();
    await expectRestored(col, before);
    expect(db.collections.items._dirty).toBe(false);
    expect(await adapter.read("items")).toBe(persisted);
    expect(events).toEqual([]);
    await db.disconnect(); await db.connect();
    await expectRestored(db.useCollection("items"), before);
  });
}

test.each(["_indexDoc", "push"])("upsertMany retains only its completed prefix after %s failure", async target => {
  const { col, db } = await setup();
  const Class = target === "push" ? DataStore : IndexEngine;
  await inject(Class, target, 2, () => col.upsertMany([{ _id: "c", n: 3, group: "g" }, { _id: "d", n: 4, group: "g" }], "_id"));
  expect((await col.find({})).docs.map(d => d._id)).toEqual(["a", "b", "c"]);
  await expectIndexMatchesScan(col, "n", 4);
  await db.disconnect(); await db.connect();
  expect((await db.useCollection("items").find({})).docs.map(d => d._id)).toEqual(["a", "b", "c"]);
});

test.each(["remove", "spliceRange"])("capacity failure at %s rolls back the enclosing insertion", async target => {
  const { col } = await setup({ maxDocs: 2 });
  const before = structuredClone((await col.find({})).docs);
  await inject(target === "remove" ? IndexEngine : DataStore, target, 1, () => col.insertOne({ _id: "c", n: 3, group: "g" }));
  await expectRestored(col, before);
});

test("failed update preserves an already dirty collection", async () => {
  const { db, col } = await setup();
  await col.updateOne({ _id: "a" }, { group: "dirty" }, { save: false });
  const before = structuredClone((await col.find({})).docs);
  await inject(IndexEngine, "_indexDoc", 1, () => col.updateOne({ _id: "a" }, { n: 11 }));
  await expectRestored(col, before);
  expect(db.collections.items._dirty).toBe(true);
});

test.each(["deleteOne", "deleteMany"])("soft %s recovers document flags and indexes", async method => {
  const { col } = await setup({ softDelete: true });
  const before = structuredClone((await col.find({})).docs);
  await inject(DataStore, "replaceAt", 1, () => col[method]({}));
  await expectRestored(col, before);
  expect((await col.find({}, { includeDeleted: true })).docs).toEqual(before);
});

test("soft restore failure retains deletion state", async () => {
  const { col } = await setup({ softDelete: true });
  await col.deleteOne({ _id: "a" });
  const before = structuredClone((await col.find({}, { includeDeleted: true })).docs);
  await inject(DataStore, "replaceAt", 1, () => col.restore({ _id: "a" }));
  expect((await col.find({}, { includeDeleted: true })).docs).toEqual(before);
  expect(await col.findOne({ _id: "a" })).toBeNull();
});

test.each(["all", "one-delete", "one-update", "one-insert"])("historical restore %s recovers its commit", async mode => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date("2020-01-01"));
    const { db, col } = await setup({ changelog: true });
    let targetTime = new Date();
    vi.setSystemTime(new Date("2021-01-01"));
    if (mode === "one-insert" || mode === "one-delete") await col.deleteOne({ _id: "a" });
    else await col.updateOne({ _id: "a" }, { group: "changed" });
    if (mode === "one-delete") {
      targetTime = new Date();
      vi.setSystemTime(new Date("2022-01-01"));
      await col.insertOne({ _id: "a", n: 1, group: "g" });
    }
    const before = structuredClone((await col.find({})).docs);
    await inject(DataStore, mode === "all" ? "replaceAll" : mode === "one-delete" ? "spliceAt" : mode === "one-insert" ? "push" : "replaceAt", 1,
      () => db.restore("items", targetTime, mode === "all" ? {} : { _id: "a" }));
    await expectRestored(col, before);
  } finally { vi.useRealTimers(); }
});

test("transaction can catch a recovered fault and commit a later valid write", async () => {
  const { db, col } = await setup();
  await db.transaction(async tx => {
    const owned = tx.useCollection("items");
    await inject(IndexEngine, "_indexDoc", 1, () => owned.updateOne({ _id: "a" }, { n: 11 }));
    await owned.updateOne({ _id: "b" }, { group: "changed" });
  });
  expect((await col.findOne({ _id: "a" })).n).toBe(1);
  expect((await col.findOne({ _id: "b" })).group).toBe("changed");
});

test("upsertMany update failure preserves its completed prefix", async () => {
  const { col } = await setup();
  await inject(DataStore, "replaceAt", 2, () => col.upsertMany([{ _id: "a", n: 11 }, { _id: "b", n: 12 }], "_id"));
  expect((await col.findOne({ _id: "a" })).n).toBe(11);
  expect((await col.findOne({ _id: "b" })).n).toBe(2);
  await expectIndexMatchesScan(col, "n", 12);
});

test("upsertMany capacity failure finalizes completed inserts without partial eviction", async () => {
  const { col, db } = await setup({ maxDocs: 2 });
  await inject(IndexEngine, "remove", 1, () => col.upsertMany([{ _id: "c", n: 3, group: "g" }], "_id"));
  expect((await col.find({})).docs.map(d => d._id)).toEqual(["a", "b", "c"]);
  await db.disconnect(); await db.connect();
  expect((await db.useCollection("items").find({})).docs.map(d => d._id)).toEqual(["a", "b", "c"]);
});

test.each(["insertOne", "upsertMany"])("%s failed recovery reports both errors and blocks writes and persistence", async method => {
  const { db, col, adapter } = await setup();
  const stored = await adapter.read("items");
  const commitError = new Error("commit failure");
  const recoveryError = new Error("rebuild failure");
  const index = IndexEngine.prototype._indexDoc;
  const build = IndexEngine.prototype.buildFromData;
  let calls = 0;
  const events = [];
  const unwatch = col.watch(event => events.push(event));
  IndexEngine.prototype._indexDoc = function (doc) {
    index.call(this, doc);
    if (++calls === (method === "upsertMany" ? 2 : 1)) throw commitError;
  };
  IndexEngine.prototype.buildFromData = () => { throw recoveryError; };
  let failure;
  try {
    if (method === "insertOne") await col.insertOne({ _id: "c", n: 3, group: "g" });
    else await col.upsertMany([{ _id: "c", n: 3, group: "g" }, { _id: "d", n: 4, group: "g" }], "_id");
  }
  catch (error) { failure = error; }
  finally { IndexEngine.prototype._indexDoc = index; IndexEngine.prototype.buildFromData = build; }
  unwatch();
  expect(events).toEqual([]);
  expect(failure).toMatchObject({ code: "ERR_SKALEX_MUTATION_RECOVERY", details: { mutationError: commitError, recoveryError } });
  await expect(col.insertOne({ _id: "d", n: 4 })).rejects.toBe(failure);
  await expect(db.saveData("items")).rejects.toBe(failure);
  expect(await adapter.read("items")).toBe(stored);
  databases.splice(databases.indexOf(db), 1);
  await expect(db.disconnect()).rejects.toBe(failure);
});
