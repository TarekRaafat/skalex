import { afterEach, expect, test } from "vitest";
import Skalex from "../../src/index.js";
import MemoryAdapter from "../helpers/MemoryAdapter.js";
import { parseSchema, validateDoc } from "../../src/engine/validator.js";

const databases = [];
async function setup(options = {}) {
  const warnings = [];
  const db = new Skalex({ adapter: new MemoryAdapter(), logger: (message, level) => { if (level === "warn") warnings.push(message); } });
  await db.connect();
  databases.push(db);
  const col = db.createCollection("items", { schema: { name: "string", n: "number" }, strict: true, ...options });
  await col.insertMany([{ _id: "a", name: "first", n: 1 }, { _id: "b", name: "second", n: 2 }]);
  return { db, col, warnings };
}
afterEach(async () => { await Promise.all(databases.splice(0).map(db => db.disconnect())); });

test.each(["updateOne", "updateMany", "upsert"])("%s accepts generated timestamps in strict documents", async method => {
  const { col } = await setup({ versioning: true });
  const before = await col.findOne({ _id: "a" });
  await col[method]({ _id: "a" }, { n: { $inc: 1 } });
  const after = await col.findOne({ _id: "a" });
  expect(after.n).toBe(2);
  expect(after.createdAt).toEqual(before.createdAt);
  expect(after.updatedAt).toBeInstanceOf(Date);
  expect(after._version).toBe(before._version + 1);
});

test("upsertMany updates existing strict documents and inserts new ones", async () => {
  const { col } = await setup();
  await col.upsertMany([{ _id: "a", name: "changed", n: 3 }, { _id: "c", name: "new", n: 4 }], "_id");
  expect((await col.findOne({ _id: "a" })).name).toBe("changed");
  expect((await col.findOne({ _id: "c" })).n).toBe(4);
});

test("transaction updates persist and reload with a strict schema", async () => {
  const { db } = await setup();
  await db.transaction(async tx => { await tx.useCollection("items").updateOne({ _id: "a" }, { n: 9 }); });
  await db.disconnect();
  await db.connect();
  expect((await db.useCollection("items").findOne({ _id: "a" })).n).toBe(9);
});

test.each(["createdAtExtra", "updatedAtExtra", "CreatedAt", "extra"])("strict updates still reject unknown field %s without changing data", async field => {
  const { col } = await setup();
  const before = await col.findOne({ _id: "a" });
  await expect(col.updateMany({}, { [field]: 1, n: 10 })).rejects.toMatchObject({ code: "ERR_SKALEX_VALIDATION_UPDATE" });
  expect(await col.findOne({ _id: "a" })).toEqual(before);
  expect((await col.findOne({ _id: "b" })).n).toBe(2);
});

test("valid strict updates do not generate schema warnings", async () => {
  const { col, warnings } = await setup({ onSchemaError: "warn" });
  await col.updateOne({ _id: "a" }, { n: 8 });
  expect(warnings).toEqual([]);
});

test("strip mode retains timestamps and prior invalid field values", async () => {
  const { col } = await setup({ onSchemaError: "strip" });
  const before = await col.findOne({ _id: "a" });
  await col.updateOne({ _id: "a" }, { n: "bad", name: "changed", extra: true });
  const after = await col.findOne({ _id: "a" });
  expect(after).toMatchObject({ n: 1, name: "changed", createdAt: before.createdAt });
  expect(after.updatedAt).toBeInstanceOf(Date);
  expect(after).not.toHaveProperty("extra");
});

test("empty strict schema permits a timestamped document update", async () => {
  const { db } = await setup();
  const col = db.createCollection("empty", { schema: {}, strict: true });
  await col.insertOne({ _id: "a" });
  await col.updateOne({ _id: "a" }, {});
  expect((await col.findOne({ _id: "a" })).updatedAt).toBeInstanceOf(Date);
});

test.each(["createdAt", "updatedAt"])("explicit schema constraints still validate %s", field => {
  const { fields } = parseSchema({ [field]: { type: "date", required: true } });
  expect(validateDoc({ [field]: new Date() }, fields, true)).toEqual([]);
  expect(validateDoc({ [field]: "bad" }, fields, true)).toContain('Field "' + field + '" must be of type "date", got "string"');
  expect(validateDoc({}, fields, true)).toContain('Field "' + field + '" is required');
});
