import { describe, expect, test } from "vitest";
import Skalex from "../../src/index.js";
import MemoryAdapter from "../helpers/MemoryAdapter.js";
import expectIndexMatchesScan from "../helpers/expectIndexMatchesScan.js";

const gate = () => {
  let release;
  const promise = new Promise(r => { release = r; });
  return { promise, release };
};
async function setup() {
  const adapter = new MemoryAdapter();
  const db = new Skalex({ adapter });
  await db.connect();
  const col = db.createCollection("items", { changelog: true, indexes: ["value"] });
  await col.insertOne({ _id: "x", value: "original" });
  await db.saveData();
  return { db, adapter, col };
}
const invoke = (db, entry, mode, timestamp) =>
  (entry === "db" ? db : db.changelog()).restore("items", timestamp, mode === "one" ? { _id: "x" } : {});
const scenarios = ["db", "changelog"].flatMap(entry => ["one", "all"].map(mode => [entry, mode]));

describe("historical restore coordination", () => {
  test.each(scenarios)("%s %s restore rejects a transaction lock without effects", async (entry, mode) => {
    const { db, col, adapter } = await setup();
    const events = [];
    db.watch(event => { if (event.collection === "items") events.push(event.op); });
    let writes = 0;
    const write = adapter.write.bind(adapter);
    adapter.write = async (name, data) => { writes++; await write(name, data); };
    const entered = gate(), finish = gate();
    const running = db.transaction(async tx => {
      await tx.useCollection("items").updateOne({ _id: "x" }, { value: "transaction" });
      entered.release();
      await finish.promise;
      throw new Error("rollback");
    }).catch(error => error);
    await entered.promise;
    let rejected;
    try { await invoke(db, entry, mode, new Date("2100-01-01")); } catch (error) { rejected = error; }
    finish.release();
    expect((await running).message).toBe("rollback");
    expect(rejected).toMatchObject({ code: "ERR_SKALEX_TX_COLLECTION_LOCKED" });
    expect(writes).toBe(0);
    expect(events).toEqual([]);
    expect((await col.findOne({ _id: "x" })).value).toBe("original");
    const reopened = new Skalex({ adapter });
    await reopened.connect();
    expect((await reopened.useCollection("items").findOne({ _id: "x" })).value).toBe("original");
    await expectIndexMatchesScan(col, "value", "original");
    await expectIndexMatchesScan(col, "value", "transaction");
  });

  test.each(scenarios)("%s %s restore checks locks after awaiting history", async (entry, mode) => {
    const { db, col } = await setup();
    const entered = gate(), finishRead = gate();
    db.use({ beforeFind: async ({ collection }) => {
      if (collection === "_changelog") { entered.release(); await finishRead.promise; }
    } });
    const restoring = invoke(db, entry, mode, new Date("2100-01-01")).then(() => null, error => error);
    await entered.promise;
    await db.transaction(async tx => {
      await tx.useCollection("items").updateOne({ _id: "x" }, { value: "committed" });
      finishRead.release();
      expect(await restoring).toMatchObject({ code: "ERR_SKALEX_TX_COLLECTION_LOCKED" });
    });
    expect((await col.findOne({ _id: "x" })).value).toBe("committed");
  });

  test.each(["one", "all"])("%s restore emits events only after its save", async mode => {
    const { db, col, adapter } = await setup();
    const archivedAt = new Date();
    await new Promise(r => setTimeout(r, 5));
    await col.updateOne({ _id: "x" }, { value: "later" });
    const historyCount = (await db.changelog().query("items")).length;
    const events = [], hooks = [];
    db.watch(event => { if (event.collection === "items") events.push(event.op); });
    db.use({
      beforeInsert: () => { hooks.push("beforeInsert"); },
      afterInsert: () => { hooks.push("afterInsert"); },
      beforeUpdate: () => { hooks.push("beforeUpdate"); },
      afterUpdate: () => { hooks.push("afterUpdate"); },
      beforeDelete: () => { hooks.push("beforeDelete"); },
      afterDelete: () => { hooks.push("afterDelete"); },
    });
    const entered = gate(), finishSave = gate();
    const write = adapter.write.bind(adapter);
    adapter.write = async (name, data) => {
      if (name === "items") { entered.release(); await finishSave.promise; }
      await write(name, data);
    };
    const restoring = invoke(db, "db", mode, archivedAt);
    await entered.promise;
    const earlyEvents = [...events];
    finishSave.release();
    await restoring;
    expect(earlyEvents).toEqual([]);
    expect(events).toEqual(mode === "one" ? ["update"] : ["delete", "insert"]);
    expect(hooks).toEqual([]);
    expect((await db.changelog().query("items")).length).toBe(historyCount);
    expect((await col.findOne({ _id: "x" })).value).toBe("original");
  });

  test("single restore rejects conflicting unique history before changing data", async () => {
    const adapter = new MemoryAdapter(), db = new Skalex({ adapter });
    await db.connect();
    const col = db.createCollection("items", { changelog: true, schema: { value: { type: "string", unique: true } } });
    await col.insertOne({ _id: "x", value: "original" });
    const timestamp = new Date();
    await new Promise(r => setTimeout(r, 5));
    await col.updateOne({ _id: "x" }, { value: "later" });
    await col.insertOne({ _id: "y", value: "original" });
    await expect(db.restore("items", timestamp, { _id: "x" })).rejects.toMatchObject({ code: "ERR_SKALEX_UNIQUE_VIOLATION" });
    expect((await col.findOne({ _id: "x" })).value).toBe("later");
    await expectIndexMatchesScan(col, "value", "original");
    await expectIndexMatchesScan(col, "value", "later");
  });

  test("restore remains available on an unlocked collection during another transaction", async () => {
    const { db, col } = await setup();
    await db.transaction(async tx => {
      await tx.useCollection("other").insertOne({ _id: "owned" });
      await db.restore("items", new Date(0));
      expect(await col.count()).toBe(0);
    });
  });
});

describe("historical restore failure boundaries", () => {
  test.each(["one", "all"])("%s save failure leaves retryable dirty state without events", async mode => {
    const { db, col, adapter } = await setup();
    const timestamp = new Date();
    await new Promise(r => setTimeout(r, 5));
    await col.updateOne({ _id: "x" }, { value: "later" });
    await db.saveData();
    const events = [];
    db.watch(event => { if (event.collection === "items") events.push(event.op); });
    adapter.throwOnWrite = name => name === "items";
    await expect(invoke(db, "changelog", mode, timestamp)).rejects.toThrow();
    expect(events).toEqual([]);
    expect((await col.findOne({ _id: "x" })).value).toBe("original");
    adapter.throwOnWrite = false;
    await db.saveData("items");
    const reopened = new Skalex({ adapter });
    await reopened.connect();
    expect((await reopened.useCollection("items").findOne({ _id: "x" })).value).toBe("original");
  });

  test.each(["unique", "compound"])("full restore validates current %s indexes before replacing state", async kind => {
    const adapter = new MemoryAdapter();
    let db = new Skalex({ adapter });
    await db.connect();
    const old = db.createCollection("items", { changelog: true });
    await old.insertMany([
      { _id: "x", value: "same", group: { nested: true } },
      { _id: "y", value: "same", group: "valid" },
    ]);
    const timestamp = new Date();
    await new Promise(r => setTimeout(r, 5));
    const options = kind === "unique" ? { schema: { value: { type: "string", unique: true } } }
      : { indexes: [["value", "group"]] };
    await old.deleteMany({});
    await db.disconnect();
    db = new Skalex({ adapter });
    const col = db.createCollection("items", { changelog: true, ...options });
    await db.connect();
    await col.insertOne({ _id: "keep", value: "current", group: "valid" });
    const events = [];
    db.watch(event => { if (event.collection === "items") events.push(event.op); });
    await expect(db.restore("items", timestamp)).rejects.toMatchObject({
      code: kind === "unique" ? "ERR_SKALEX_UNIQUE_VIOLATION" : "ERR_SKALEX_VALIDATION_COMPOUND_INDEX",
      message: expect.stringContaining(kind === "unique" ? 'value "same"' : 'field "group"'),
    });
    expect((await col.find({})).docs.map(doc => doc._id)).toEqual(["keep"]);
    expect(events).toEqual([]);
    await expectIndexMatchesScan(col, "value", "current");
    if (kind === "compound") await expectIndexMatchesScan(col, { value: "current", group: "valid" });
  });

  test.each(["one", "all"])("%s restored nested values do not share references with the archive", async mode => {
    const { db, col } = await setup();
    await col.insertOne({ _id: "nested", payload: { n: 1 } });
    await db.restore("items", new Date("2100-01-01"), mode === "one" ? { _id: "nested" } : {});
    const restored = await col.findOne({ _id: "nested" });
    restored.payload.n = 9;
    await db.restore("items", new Date("2100-01-01"), mode === "one" ? { _id: "nested" } : {});
    expect((await col.findOne({ _id: "nested" })).payload.n).toBe(1);
  });

  test("independent restore and its effects survive another collection's rollback", async () => {
    const { db, col, adapter } = await setup();
    const events = [];
    db.watch(event => { if (event.collection === "items") events.push(event.op); });
    await expect(db.transaction(async tx => {
      await tx.useCollection("other").insertOne({ _id: "owned" });
      await db.changelog().restore("items", new Date(0));
      expect(events).toEqual(["delete"]);
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect(await col.count()).toBe(0);
    const reopened = new Skalex({ adapter });
    await reopened.connect();
    expect(await reopened.useCollection("items").count()).toBe(0);
    expect(events).toEqual(["delete"]);
  });
});

describe("full historical replacement constraints", () => {
  test.each(["db", "changelog"].flatMap(entry =>
    ["shrink", "grow", "empty", "same-size"].map(shape => [entry, shape])
  ))("%s restores valid %s unique snapshots", async (entry, shape) => {
    const adapter = new MemoryAdapter(), db = new Skalex({ adapter });
    await db.connect();
    const col = db.createCollection("items", { changelog: true, schema: { value: { type: "string", unique: true } } });
    if (shape !== "empty") await col.insertMany([{ _id: "x", value: "a" }, { _id: "y", value: "b" }]);
    const timestamp = new Date();
    await new Promise(r => setTimeout(r, 5));
    if (shape === "grow") await col.deleteMany({});
    else if (shape === "same-size") {
      await col.deleteMany({});
      await col.insertMany([{ _id: "z", value: "a" }, { _id: "w", value: "b" }]);
    } else await col.insertOne({ _id: "z", value: "c" });
    await invoke(db, entry, "all", timestamp);
    const expected = shape === "empty" ? [] : ["x", "y"];
    expect((await col.find({})).docs.map(doc => doc._id)).toEqual(expected);
    for (const value of ["a", "b", "c"]) await expectIndexMatchesScan(col, "value", value);
    const reopened = new Skalex({ adapter });
    await reopened.connect();
    expect((await reopened.useCollection("items").find({})).docs.map(doc => doc._id)).toEqual(expected);
  });

  test.each(["db", "changelog"].flatMap(entry =>
    [false, true].map(populated => [entry, populated])
  ))("%s rejects duplicate archive with populated=%s", async (entry, populated) => {
    const adapter = new MemoryAdapter();
    let db = new Skalex({ adapter });
    await db.connect();
    const old = db.createCollection("items", { changelog: true });
    await old.insertMany([{ _id: "x", value: "duplicate" }, { _id: "y", value: "duplicate" }]);
    const timestamp = new Date();
    await new Promise(r => setTimeout(r, 5));
    await old.deleteMany({});
    await db.disconnect();
    db = new Skalex({ adapter });
    const col = db.createCollection("items", { changelog: true, schema: { value: { type: "string", unique: true } } });
    await db.connect();
    if (populated) await col.insertOne({ _id: "keep", value: "current" });
    await db.saveData();
    const events = [];
    db.watch(event => { if (event.collection === "items") events.push(event); });
    await expect(invoke(db, entry, "all", timestamp)).rejects.toMatchObject({
      code: "ERR_SKALEX_UNIQUE_VIOLATION",
      message: expect.stringContaining('value "duplicate"'),
    });
    const expected = populated ? ["keep"] : [];
    expect((await col.find({})).docs.map(doc => doc._id)).toEqual(expected);
    expect(events).toEqual([]);
    for (const value of ["duplicate", "current"]) await expectIndexMatchesScan(col, "value", value);
    const reopened = new Skalex({ adapter });
    await reopened.connect();
    expect((await reopened.useCollection("items").find({})).docs.map(doc => doc._id)).toEqual(expected);
  });
});
