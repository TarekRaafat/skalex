/**
 * Integration tests for the out-of-band BigInt/Date serializer introduced
 * in alpha.6.
 *
 * Guarantees verified here:
 *   1. BigInt and Date round-trip through the persistence layer.
 *   2. Nested BigInt/Date values at arbitrary depth round-trip.
 *   3. Documents with literal `__skalex_bigint__` / `__skalex_date__` keys
 *      round-trip as-is (no silent BigInt/Date revival).
 *   4. Legacy inline-tag payloads produced by alpha.5 and earlier still load
 *      correctly.
 *   5. Re-saving a legacy collection rewrites it in the new wrapped format.
 */
import { describe, test, expect } from "vitest";
import Skalex from "../../src/index.js";
import MemoryAdapter from "../helpers/MemoryAdapter.js";

describe("out-of-band type serializer", () => {
  test("BigInt round-trips through persistence", async () => {
    const adapter = new MemoryAdapter();
    const db1 = new Skalex({ adapter });
    await db1.connect();
    const col1 = db1.useCollection("big");
    const big = 9007199254740993n; // Number.MAX_SAFE_INTEGER + 2
    await col1.insertOne({ _id: "a", n: big }, { save: true });
    await db1.disconnect();

    const db2 = new Skalex({ adapter });
    await db2.connect();
    const found = await db2.useCollection("big").findOne({ _id: "a" });
    expect(typeof found.n).toBe("bigint");
    expect(found.n).toBe(big);
    await db2.disconnect();
  });

  test("Date round-trips through persistence", async () => {
    const adapter = new MemoryAdapter();
    const db1 = new Skalex({ adapter });
    await db1.connect();
    const col1 = db1.useCollection("dates");
    const when = new Date("2030-06-15T12:34:56.789Z");
    await col1.insertOne({ _id: "a", when }, { save: true });
    await db1.disconnect();

    const db2 = new Skalex({ adapter });
    await db2.connect();
    const found = await db2.useCollection("dates").findOne({ _id: "a" });
    expect(found.when).toBeInstanceOf(Date);
    expect(found.when.toISOString()).toBe(when.toISOString());
    await db2.disconnect();
  });

  test("nested BigInt/Date at depth round-trip", async () => {
    const adapter = new MemoryAdapter();
    const db1 = new Skalex({ adapter });
    await db1.connect();
    const col1 = db1.useCollection("nested");
    const doc = {
      _id: "n",
      level1: {
        arr: [
          { big: 123456789012345678901234567890n, stamp: new Date("2040-01-01T00:00:00Z") },
          { big: 42n },
        ],
        map: { inner: { big: 1n } },
      },
    };
    await col1.insertOne(doc, { save: true });
    await db1.disconnect();

    const db2 = new Skalex({ adapter });
    await db2.connect();
    const loaded = await db2.useCollection("nested").findOne({ _id: "n" });
    expect(typeof loaded.level1.arr[0].big).toBe("bigint");
    expect(loaded.level1.arr[0].big).toBe(123456789012345678901234567890n);
    expect(loaded.level1.arr[0].stamp).toBeInstanceOf(Date);
    expect(loaded.level1.arr[0].stamp.toISOString()).toBe("2040-01-01T00:00:00.000Z");
    expect(loaded.level1.arr[1].big).toBe(42n);
    expect(loaded.level1.map.inner.big).toBe(1n);
    await db2.disconnect();
  });

  test("document with literal `__skalex_bigint__` key is NOT revived as BigInt", async () => {
    const adapter = new MemoryAdapter();
    const db1 = new Skalex({ adapter });
    await db1.connect();
    const col1 = db1.useCollection("edge");
    // User payload happens to contain a string field named `__skalex_bigint__`.
    // In the old inline-tag format this would have been misread as a BigInt.
    // The out-of-band format must preserve it exactly.
    await col1.insertOne({ _id: "e", payload: { __skalex_bigint__: "this-is-a-regular-string" } }, { save: true });
    await db1.disconnect();

    const db2 = new Skalex({ adapter });
    await db2.connect();
    const found = await db2.useCollection("edge").findOne({ _id: "e" });
    expect(found.payload).toEqual({ __skalex_bigint__: "this-is-a-regular-string" });
    expect(typeof found.payload).toBe("object");
    expect(typeof found.payload.__skalex_bigint__).toBe("string");
    await db2.disconnect();
  });

  test("document with literal `__skalex_date__` key is NOT revived as Date", async () => {
    const adapter = new MemoryAdapter();
    const db1 = new Skalex({ adapter });
    await db1.connect();
    const col1 = db1.useCollection("edge2");
    await col1.insertOne({ _id: "d", meta: { __skalex_date__: "2025-01-01" } }, { save: true });
    await db1.disconnect();

    const db2 = new Skalex({ adapter });
    await db2.connect();
    const found = await db2.useCollection("edge2").findOne({ _id: "d" });
    expect(found.meta).toEqual({ __skalex_date__: "2025-01-01" });
    expect(found.meta.__skalex_date__).not.toBeInstanceOf(Date);
    await db2.disconnect();
  });

  test("loads legacy inline-tag payloads (alpha.5 format)", async () => {
    const adapter = new MemoryAdapter();
    // Hand-crafted alpha.5 payload: a collection with BigInt inline-tagged,
    // a Date inline-tagged, and no `{ data, meta }` wrapper.
    const legacyPayload = {
      collectionName: "legacy",
      schema: null,
      rawSchema: null,
      data: [
        {
          _id: "legacy-1",
          big: { __skalex_bigint__: "123456789012345" },
          when: { __skalex_date__: "2024-05-01T10:00:00.000Z" },
          createdAt: { __skalex_date__: "2024-05-01T10:00:00.000Z" },
          updatedAt: { __skalex_date__: "2024-05-01T10:00:00.000Z" },
        },
      ],
      changelog: false,
      softDelete: false,
      versioning: false,
      strict: false,
      onSchemaError: "throw",
      defaultTtl: null,
      defaultEmbed: null,
      maxDocs: null,
    };
    adapter._store.set("legacy", JSON.stringify(legacyPayload));

    const db = new Skalex({ adapter });
    await db.connect();
    const found = await db.useCollection("legacy").findOne({ _id: "legacy-1" });
    expect(typeof found.big).toBe("bigint");
    expect(found.big).toBe(123456789012345n);
    expect(found.when).toBeInstanceOf(Date);
    expect(found.when.toISOString()).toBe("2024-05-01T10:00:00.000Z");
    await db.disconnect();
  });

  test("re-saving legacy payload migrates it to the new wrapped format", async () => {
    const adapter = new MemoryAdapter();
    const legacyPayload = {
      collectionName: "legacy2",
      schema: null,
      rawSchema: null,
      data: [{ _id: "m-1", big: { __skalex_bigint__: "42" } }],
      changelog: false,
      softDelete: false,
      versioning: false,
      strict: false,
      onSchemaError: "throw",
      defaultTtl: null,
      defaultEmbed: null,
      maxDocs: null,
    };
    adapter._store.set("legacy2", JSON.stringify(legacyPayload));

    const db = new Skalex({ adapter });
    await db.connect();
    // Any save on the collection triggers the new format.
    await db.useCollection("legacy2").insertOne({ _id: "m-2", big: 99n }, { save: true });
    await db.disconnect();

    const raw = await adapter.read("legacy2");
    const parsed = JSON.parse(raw);
    // New format: top-level `{ data, meta }` wrapper.
    expect(parsed).toHaveProperty("data");
    expect(parsed).toHaveProperty("meta");
    expect(parsed.meta).toHaveProperty("types");
    // Inner payload is the collection: `data.data` is the docs array.
    expect(Array.isArray(parsed.data.data)).toBe(true);
    expect(parsed.data.data).toHaveLength(2);
    // BigInt values are stored as strings inside `data`, with paths in `meta.types.bigint`.
    expect(parsed.meta.types.bigint?.length ?? 0).toBeGreaterThan(0);
    // And reloading recovers the BigInt values faithfully.
    const db2 = new Skalex({ adapter });
    await db2.connect();
    const all = (await db2.useCollection("legacy2").find({}, { sort: { _id: 1 } })).docs;
    expect(all.map(d => d._id)).toEqual(["m-1", "m-2"]);
    expect(all[0].big).toBe(42n);
    expect(all[1].big).toBe(99n);
    await db2.disconnect();
  });

  test("meta.types omits type keys with no matches", async () => {
    // A plain payload still has createdAt/updatedAt Dates on each doc, so the
    // Date key will be populated. But `bigint` should not appear when no
    // BigInt values are present.
    const adapter = new MemoryAdapter();
    const db = new Skalex({ adapter });
    await db.connect();
    await db.useCollection("plain").insertOne({ _id: "p", s: "hello", n: 7 }, { save: true });
    await db.disconnect();

    const raw = await adapter.read("plain");
    const parsed = JSON.parse(raw);
    expect(parsed.meta.types.bigint).toBeUndefined();
    expect(Array.isArray(parsed.meta.types.Date)).toBe(true);
    expect(parsed.meta.types.Date.length).toBeGreaterThan(0);
  });
});
