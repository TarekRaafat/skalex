import { expect, test } from "vitest";
import Skalex from "../../src/index.js";
import MemoryAdapter from "../helpers/MemoryAdapter.js";

const latch = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
async function setup() {
  const adapter = new MemoryAdapter(), db = new Skalex({ adapter, logger: () => {} });
  await db.connect();
  await db.useCollection("items").insertOne({ _id: "x", n: 0 }, { save: true });
  const writeAll = adapter.writeAll.bind(adapter);
  adapter.writeAll = async () => { throw new Error("batch failed"); };
  await expect(db.transaction(tx => tx.useCollection("items").updateOne({ _id: "x" }, { n: 1 }))).rejects.toThrow();
  adapter.writeAll = writeAll;
  return { adapter, db };
}
async function warnings(adapter) {
  const messages = [], db = new Skalex({ adapter, logger: message => messages.push(message) });
  await db.connect();
  return messages.filter(message => message.includes("Incomplete flush"));
}

test("acknowledgement persists across saves and reconnect without repairing data", async () => {
  const { db, adapter } = await setup();
  expect(await warnings(adapter)).toHaveLength(1);
  await db.useCollection("items").updateOne({ _id: "x" }, { n: 9 });
  await db.acknowledgeIncompleteFlush();
  expect(await warnings(adapter)).toHaveLength(0);
  const check = new Skalex({ adapter });
  await check.connect();
  expect((await check.useCollection("items").findOne({ _id: "x" })).n).toBe(0);
  await db.saveData("_meta");
  expect(await warnings(adapter)).toHaveLength(0);
});

test("acknowledgement without a warning is an I/O-free no-op", async () => {
  const adapter = new MemoryAdapter(), db = new Skalex({ adapter });
  await db.connect();
  adapter.throwOnRead = true;
  adapter.throwOnWrite = true;
  await expect(db.acknowledgeIncompleteFlush()).resolves.toBeUndefined();
});

test("failed acknowledgement retains the warning and can be retried", async () => {
  const { db, adapter } = await setup();
  adapter.throwOnWrite = true;
  await expect(db.acknowledgeIncompleteFlush()).rejects.toMatchObject({ code: "ERR_SKALEX_PERSISTENCE_ACK_FAILED" });
  adapter.throwOnWrite = false;
  expect(await warnings(adapter)).toHaveLength(1);
  await db.saveData("_meta");
  expect(await warnings(adapter)).toHaveLength(1);
  await db.acknowledgeIncompleteFlush();
  expect(await warnings(adapter)).toHaveLength(0);
});

test("acknowledgement requires connection and rejects during a transaction", async () => {
  const db = new Skalex({ adapter: new MemoryAdapter() });
  await expect(db.acknowledgeIncompleteFlush()).rejects.toMatchObject({ code: "ERR_SKALEX_PERSISTENCE_ACK_FAILED" });
  await db.connect();
  await db.transaction(async tx => {
    await expect(db.acknowledgeIncompleteFlush()).rejects.toMatchObject({ code: "ERR_SKALEX_PERSISTENCE_ACK_FAILED" });
    expect(() => tx.acknowledgeIncompleteFlush).toThrow(expect.objectContaining({ code: "ERR_SKALEX_TX_DIRECT_ACCESS" }));
  });
});

test("acknowledgement queued during a failing batch cannot clear its new warning", async () => {
  const { db, adapter } = await setup();
  const entered = latch(), release = latch();
  adapter.writeAll = async () => { entered.release(); await release.promise; throw new Error("new failure"); };
  const committing = db.transaction(tx => tx.useCollection("items").updateOne({ _id: "x" }, { n: 2 })).catch(error => error);
  await entered.promise;
  const acknowledging = db.acknowledgeIncompleteFlush().catch(error => error);
  release.release();
  await committing;
  expect((await acknowledging).code).toBe("ERR_SKALEX_PERSISTENCE_ACK_FAILED");
  expect(await warnings(adapter)).toHaveLength(1);
});

test("a failure after acknowledgement creates a new durable warning", async () => {
  const { db, adapter } = await setup();
  const entered = latch(), release = latch(), write = adapter.write.bind(adapter);
  let pause = true;
  adapter.write = async (name, data) => {
    if (name === "_meta" && pause) { pause = false; entered.release(); await release.promise; }
    await write(name, data);
  };
  const acknowledging = db.acknowledgeIncompleteFlush();
  await entered.promise;
  adapter.writeAll = async () => { throw new Error("new failure"); };
  const committing = db.transaction(tx => tx.useCollection("items").updateOne({ _id: "x" }, { n: 2 })).catch(error => error);
  release.release();
  await acknowledging;
  await committing;
  expect(await warnings(adapter)).toHaveLength(1);
});

test("a healthy database can acknowledge a failed final marker clear", async () => {
  const adapter = new MemoryAdapter(), db = new Skalex({ adapter, logger: () => {} });
  await db.connect();
  const write = adapter.write.bind(adapter);
  adapter.write = async (name, data) => {
    if (name === "_meta" && JSON.parse(data).data.data.find(doc => doc._id === "migrations")?._flush?.completedAt) throw new Error("clear failed");
    await write(name, data);
  };
  await db.transaction(tx => tx.useCollection("items").insertOne({ _id: "x", n: 1 }));
  adapter.write = write;
  const logs = [], reopened = new Skalex({ adapter, logger: message => logs.push(message) });
  await reopened.connect();
  expect(logs.some(message => message.includes("Incomplete flush"))).toBe(true);
  expect((await reopened.useCollection("items").findOne({ _id: "x" })).n).toBe(1);
  await reopened.acknowledgeIncompleteFlush();
  expect(await warnings(adapter)).toHaveLength(0);
});

test("acknowledgement preserves custom-serialized committed metadata", async () => {
  const adapter = new MemoryAdapter();
  const codec = { serializer: value => "custom:" + JSON.stringify(value), deserializer: raw => JSON.parse(raw.slice(7)) };
  const db = new Skalex({ adapter, ...codec, logger: () => {} });
  db.addMigration({ version: 1, up: tx => tx.useCollection("items").insertOne({ _id: "x", n: 0 }) });
  await db.connect();
  adapter.throwOnWriteAll = true;
  await expect(db.transaction(tx => tx.useCollection("items").updateOne({ _id: "x" }, { n: 1 }))).rejects.toThrow();
  adapter.throwOnWriteAll = false;
  await db.acknowledgeIncompleteFlush();
  const metadata = codec.deserializer(await adapter.read("_meta")).data.find(doc => doc._id === "migrations");
  expect(metadata.appliedVersions).toEqual([1]);
  const messages = [], reopened = new Skalex({ adapter, ...codec, logger: message => messages.push(message) });
  await reopened.connect();
  expect(messages.some(message => message.includes("Incomplete flush"))).toBe(false);
});
