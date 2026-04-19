/**
 * Unit tests for SkalexImporter - JSON file import into collections.
 */
import { describe, test, expect, vi } from "vitest";
import SkalexImporter from "../../src/engine/importer.js";
import { PersistenceError } from "../../src/engine/errors.js";

function makeImporter({ rawData, insertManyResult } = {}) {
  const fs = {
    readRaw: vi.fn().mockResolvedValue(rawData ?? "[]"),
  };
  const insertMany = vi.fn().mockResolvedValue(insertManyResult ?? []);
  const col = { insertMany };
  const getCollection = vi.fn().mockReturnValue(col);
  const importer = new SkalexImporter({ fs, getCollection });
  return { importer, fs, getCollection, col, insertMany };
}

describe("SkalexImporter", () => {
  test("extracts collection name from forward-slash path: /data/users.json", async () => {
    const { importer, getCollection } = makeImporter({
      rawData: JSON.stringify([{ name: "Alice" }]),
    });
    await importer.import("/data/users.json");
    expect(getCollection).toHaveBeenCalledWith("users");
  });

  test("extracts collection name from backslash path: C:\\data\\users.json", async () => {
    const { importer, getCollection } = makeImporter({
      rawData: JSON.stringify([{ name: "Bob" }]),
    });
    await importer.import("C:\\data\\users.json");
    expect(getCollection).toHaveBeenCalledWith("users");
  });

  test("extracts collection name from file with multiple dots: my.data.json", async () => {
    const { importer, getCollection } = makeImporter({
      rawData: JSON.stringify([{ v: 1 }]),
    });
    await importer.import("my.data.json");
    expect(getCollection).toHaveBeenCalledWith("my.data");
  });

  test("throws PersistenceError on invalid JSON", async () => {
    const { importer } = makeImporter({ rawData: "not valid json {{{" });
    await expect(importer.import("/data/broken.json")).rejects.toThrow(PersistenceError);
    await expect(importer.import("/data/broken.json")).rejects.toThrow(/invalid JSON/);
  });

  test("calls insertMany with parsed docs", async () => {
    const docs = [{ name: "Alice" }, { name: "Bob" }];
    const { importer, insertMany } = makeImporter({
      rawData: JSON.stringify(docs),
    });
    await importer.import("/data/users.json");
    expect(insertMany).toHaveBeenCalledWith(docs, { save: true });
  });

  test("wraps single object in array", async () => {
    const single = { name: "Solo" };
    const { importer, insertMany } = makeImporter({
      rawData: JSON.stringify(single),
    });
    await importer.import("/data/items.json");
    expect(insertMany).toHaveBeenCalledWith([single], { save: true });
  });
});
