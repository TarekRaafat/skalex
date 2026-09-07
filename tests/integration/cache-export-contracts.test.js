import { describe, test, expect } from "vitest";
import Skalex from "../../src/index.js";
import MemoryAdapter from "../helpers/MemoryAdapter.js";
import { QueryCache } from "../../src/features/ask.js";

describe("cache identity and CSV columns", () => {
  test("different colliding queries get distinct translations, including reconnect", async () => {
    const adapter = new MemoryAdapter();
    const calls = [];
    const llmAdapter = { generate: (_schema, query) => { calls.push(query); return Promise.resolve({ value: query === "Aa" ? 1 : 2 }); } };
    let db = new Skalex({ adapter, llmAdapter });
    await db.useCollection("items").insertMany([{ value: 1 }, { value: 2 }]);
    expect((await db.ask("items", "Aa")).docs[0].value).toBe(1);
    expect((await db.ask("items", "B@")).docs[0].value).toBe(2);
    await db.disconnect();
    db = new Skalex({ adapter, llmAdapter });
    await db.connect();
    expect((await db.ask("items", "Aa")).docs[0].value).toBe(1);
    expect((await db.ask("items", "B@")).docs[0].value).toBe(2);
    expect(calls).toEqual(["Aa", "B@"]);
  });

  test("legacy hash entries are discarded instead of trusted as identities", () => {
    const cache = new QueryCache();
    cache.fromJSON({ "1234abcd": { filter: { value: 1 }, ts: Date.now() } });
    expect(cache.size).toBe(0);
  });

  test("CSV uses the union of columns and preserves row alignment", async () => {
    const adapter = new MemoryAdapter();
    const db = new Skalex({ adapter });
    const col = db.useCollection("items");
    await col.insertMany([{ a: "A1", b: "B1" }, { b: "B2", a: "A2", extra: "E2" }, { a: "A3" }]);
    await col.export({}, { format: "csv", dir: "/csv", name: "items" });
    const rows = adapter.getRaw("/csv/items.csv").split("\n").map(row => row.split(","));
    const header = rows[0];
    expect(header.indexOf("extra")).toBeGreaterThan(-1);
    expect(rows.slice(1).map(row => ["a", "b", "extra"].map(field => row[header.indexOf(field)])))
      .toEqual([["A1", "B1", ""], ["A2", "B2", "E2"], ["A3", "", ""]]);
  });
});
