import { describe, expect, test } from "vitest";
import Skalex from "../../src/index.js";
import MemoryAdapter from "../helpers/MemoryAdapter.js";

describe("primary IDs remain unique across asynchronous preparation", () => {
  test("rejects a whole insertMany batch when another write claims a prepared ID", async () => {
    const db = new Skalex({ adapter: new MemoryAdapter() });
    await db.connect();
    const col = db.useCollection("items");
    let entered, release;
    const ready = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    db.use({ beforeInsert: async ({ doc }) => {
      if (doc._id === "hold") { entered(); await gate; }
    } });
    const pending = col.insertMany([{ _id: "same", value: 1 }, { _id: "hold" }]);
    const result = pending.then(() => null, error => error);
    await ready;
    try { await col.insertOne({ _id: "same", value: 2 }); }
    finally { release(); }
    expect((await result).code).toBe("ERR_SKALEX_UNIQUE_DUPLICATE_ID");
    expect((await col.find({})).docs.map(d => [d._id, d.value])).toEqual([["same", 2]]);
    await db.disconnect();
  });

  test.each(["insertOne", "insertMany", "upsertMany"])("insertOne racing %s commits one shared ID", async method => {
    const db = new Skalex({ adapter: new MemoryAdapter() });
    await db.connect();
    const col = db.useCollection("items");
    const second = () => method === "insertOne"
      ? col.insertOne({ _id: "same", value: 2 })
      : method === "insertMany"
        ? col.insertMany([{ _id: "same", value: 2 }, { _id: "other", value: 3 }])
        : col.upsertMany([{ _id: "same", value: 2 }], "value");
    const results = await Promise.allSettled([col.insertOne({ _id: "same", value: 1 }), second()]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find(r => r.status === "rejected").reason.code).toBe("ERR_SKALEX_UNIQUE_DUPLICATE_ID");
    const docs = (await col.find({})).docs;
    expect(docs.filter(d => d._id === "same")).toHaveLength(1);
    expect(new Set(docs.map(d => d._id)).size).toBe(docs.length);
    expect(await col.findOne({ _id: "same" })).toEqual(docs.find(d => d._id === "same"));
    await db.disconnect();
  });
});
