import { expect, test } from "vitest";
import Skalex from "../../src/index.js";
import MemoryAdapter from "../helpers/MemoryAdapter.js";

test("rejects a legacy temporary payload whose collection name differs from its storage key", async () => {
  const adapter = new MemoryAdapter();
  const db = new Skalex({ adapter });
  await db.connect();
  await db.useCollection("items").insertOne({ _id: "real" }, { save: true });
  const raw = await adapter.read("items");
  await adapter.write("items_12345678-1234-4234-8234-123456789abc.tmp", raw);
  const reopened = new Skalex({ adapter, logger: () => {} });
  await expect(reopened.connect()).rejects.toMatchObject({ code: "ERR_SKALEX_PERSISTENCE_CORRUPT" });
  expect(reopened.isConnected).toBe(false);
  expect(await adapter.read("items")).toBe(raw);
});
