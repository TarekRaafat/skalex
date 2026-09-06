import { describe, expect, test } from "vitest";
import Skalex from "../../src/index.js";
import MemoryAdapter from "../helpers/MemoryAdapter.js";

async function setup() {
  const adapter = new MemoryAdapter(), db = new Skalex({ adapter, logger: () => {} });
  await db.connect();
  for (const name of ["a", "b"]) await db.useCollection(name).insertOne({ _id: "x", n: 0 });
  await db.saveData();
  return { adapter, db };
}
const mutate = db => db.transaction(async tx => {
  for (const name of ["a", "b"]) await tx.useCollection(name).updateOne({ _id: "x" }, { n: 1 });
});
async function reopen(adapter) {
  const warnings = [], db = new Skalex({ adapter, logger: message => warnings.push(message) });
  await db.connect();
  const values = await Promise.all(["a", "b"].map(name => db.useCollection(name).findOne({ _id: "x" })));
  return { db, warnings, values: values.map(doc => doc?.n) };
}
const hasWarning = warnings => warnings.some(message => /Incomplete flush/.test(message));

describe("durable partial-batch detection", () => {
  test.each(["a", "b", "_meta"])("failure at batch entry %s leaves a detectable marker", async failed => {
    const { db, adapter } = await setup();
    const writeAll = adapter.writeAll.bind(adapter);
    adapter.writeAll = async entries => {
      adapter.throwOnWrite = name => name === failed;
      try { await writeAll(entries); } finally { adapter.throwOnWrite = false; }
    };
    await expect(mutate(db)).rejects.toMatchObject({ code: "ERR_SKALEX_PERSISTENCE_FLUSH_FAILED" });
    const result = await reopen(adapter);
    expect(hasWarning(result.warnings)).toBe(true);
    expect(result.values).toEqual(failed === "a" ? [0, 0] : failed === "b" ? [1, 0] : [1, 1]);
    for (const name of ["a", "b"]) expect((await db.useCollection(name).findOne({ _id: "x" })).n).toBe(0);
  });

  test.each(["save", "transaction", "reconnect-transaction"])("%s does not hide an unresolved partial batch", async mode => {
    const { db, adapter } = await setup();
    adapter.throwOnWrite = name => name === "b";
    await expect(mutate(db)).rejects.toThrow();
    adapter.throwOnWrite = false;
    let active = db;
    if (mode === "reconnect-transaction") active = (await reopen(adapter)).db;
    if (mode === "save") await active.saveData("_meta");
    else await active.transaction(tx => tx.useCollection("other").insertOne({ n: 2 }));
    const result = await reopen(adapter);
    expect(result.values).toEqual([1, 0]);
    expect(hasWarning(result.warnings)).toBe(true);
    expect(result.warnings.some(message => message.includes("a") && message.includes("b"))).toBe(true);
  });

  test("marker failure prevents batch data writes", async () => {
    const { db, adapter } = await setup();
    let batches = 0;
    const writeAll = adapter.writeAll.bind(adapter);
    adapter.writeAll = entries => { batches++; return writeAll(entries); };
    adapter.throwOnWrite = name => name === "_meta";
    await expect(mutate(db)).rejects.toMatchObject({ code: "ERR_SKALEX_PERSISTENCE_FLUSH_FAILED" });
    expect(batches).toBe(0);
    adapter.throwOnWrite = false;
    expect((await reopen(adapter)).values).toEqual([0, 0]);
  });

  test("successful batches clear their own marker", async () => {
    const { db, adapter } = await setup();
    await mutate(db);
    const result = await reopen(adapter);
    expect(result.values).toEqual([1, 1]);
    expect(hasWarning(result.warnings)).toBe(false);
  });

  test("sentinel clear failure preserves committed data and warning", async () => {
    const { db, adapter } = await setup();
    const write = adapter.write.bind(adapter);
    adapter.write = async (name, data) => {
      const completed = name === "_meta" && JSON.parse(data).data.data.find(doc => doc._id === "migrations")?._flush?.completedAt;
      if (completed) throw new Error("clear failed");
      await write(name, data);
    };
    await mutate(db);
    adapter.write = write;
    await db.saveData("_meta");
    const result = await reopen(adapter);
    expect(result.values).toEqual([1, 1]);
    expect(hasWarning(result.warnings)).toBe(true);
  });

  test("preflight marker does not publish pending migration versions", async () => {
    const adapter = new MemoryAdapter();
    const first = new Skalex({ adapter });
    first.addMigration({ version: 1, up: async tx => { await tx.useCollection("a").insertOne({ _id: "x", n: 0 }); } });
    await first.connect();
    const writeAll = adapter.writeAll.bind(adapter);
    let durableVersions;
    adapter.writeAll = async entries => {
      const stored = JSON.parse(await adapter.read("_meta"));
      durableVersions = stored.data.data.find(doc => doc._id === "migrations").appliedVersions;
      await adapter.write(entries.find(entry => entry.name === "a").name, entries.find(entry => entry.name === "a").data);
      throw new Error("migration partial batch");
    };
    const next = new Skalex({ adapter, logger: () => {} });
    next.addMigration({ version: 2, up: async tx => { await tx.useCollection("a").updateOne({ _id: "x" }, { n: 1 }); } });
    await expect(next.connect()).rejects.toThrow();
    expect(durableVersions).toEqual([1]);
    adapter.writeAll = writeAll;
    await next.saveData("_meta");
    const stored = JSON.parse(await adapter.read("_meta"));
    expect(stored.data.data.find(doc => doc._id === "migrations").appliedVersions).toEqual([1]);
    const logs = [], check = new Skalex({ adapter, logger: message => logs.push(message) });
    await check.connect();
    expect(hasWarning(logs)).toBe(true);
  });
});

test("failed metadata read prevents all batch writes", async () => {
  const { db, adapter } = await setup();
  const read = adapter.read.bind(adapter), writeAll = adapter.writeAll.bind(adapter);
  let batches = 0;
  adapter.read = name => { if (name === "_meta") throw new Error("read failed"); return read(name); };
  adapter.writeAll = entries => { batches++; return writeAll(entries); };
  await expect(mutate(db)).rejects.toMatchObject({ code: "ERR_SKALEX_PERSISTENCE_FLUSH_FAILED" });
  expect(batches).toBe(0);
  adapter.read = read;
  expect((await reopen(adapter)).values).toEqual([0, 0]);
});

test("custom serialization preserves committed metadata and incomplete detection", async () => {
  const adapter = new MemoryAdapter();
  const codec = { serializer: value => "custom:" + JSON.stringify(value), deserializer: raw => JSON.parse(raw.slice(7)) };
  const db = new Skalex({ adapter, ...codec });
  await db.connect();
  for (const name of ["a", "b"]) await db.useCollection(name).insertOne({ _id: "x", n: 0 });
  await db.saveData();
  adapter.throwOnWrite = name => name === "b";
  await expect(mutate(db)).rejects.toThrow();
  adapter.throwOnWrite = false;
  const warnings = [], reopened = new Skalex({ adapter, ...codec, logger: message => warnings.push(message) });
  await reopened.connect();
  expect(hasWarning(warnings)).toBe(true);
  expect((await reopened.useCollection("a").findOne({ _id: "x" })).n).toBe(1);
  expect((await reopened.useCollection("b").findOne({ _id: "x" })).n).toBe(0);
});
