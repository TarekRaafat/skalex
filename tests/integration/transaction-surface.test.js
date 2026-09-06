import { describe, expect, test } from "vitest";
import Skalex from "../../src/index.js";
import MemoryAdapter from "../helpers/MemoryAdapter.js";

async function setup() {
  const adapter = new MemoryAdapter();
  const db = new Skalex({ adapter });
  await db.connect();
  await db.useCollection("items").insertOne({ _id: "x", value: 1 });
  await db.saveData();
  return { db, adapter };
}
const directAccess = { code: "ERR_SKALEX_TX_DIRECT_ACCESS" };

describe("transaction capability boundary", () => {
  test("cannot persist uncommitted data through tx.saveData", async () => {
    const { db, adapter } = await setup();
    await expect(db.transaction(async tx => {
      await tx.useCollection("items").updateOne({ _id: "x" }, { value: 2 });
      await tx.saveData("items");
    })).rejects.toMatchObject(directAccess);
    expect((await db.useCollection("items").findOne({ _id: "x" })).value).toBe(1);
    const reopened = new Skalex({ adapter });
    await reopened.connect();
    expect((await reopened.useCollection("items").findOne({ _id: "x" })).value).toBe(1);
  });

  test("cannot seed independent writes through the transaction handle", async () => {
    const { db, adapter } = await setup();
    await expect(db.transaction(async tx => {
      await tx.seed({ seeded: [{ _id: "escape" }] });
    })).rejects.toMatchObject(directAccess);
    expect(Object.hasOwn(db.collections, "seeded")).toBe(false);
    expect(await adapter.read("seeded")).toBeNull();
  });

  test.each([
    "disconnect", "connect", "loadData", "renameCollection", "restore", "import",
    "useMemory", "changelog", "namespace", "mcp", "use", "watch", "transaction",
    "dump", "inspect", "stats", "sessionStats", "collections", "_collectionContext",
    "_persistence", "_registry", "constructor", "__proto__", "futureMethod",
  ])("rejects unapproved database capability %s", async property => {
    const { db } = await setup();
    await db.transaction(async tx => {
      expect(() => tx[property]).toThrow(expect.objectContaining(directAccess));
      expect(property in tx).toBe(false);
      expect(Object.getOwnPropertyDescriptor(tx, property)).toBeUndefined();
    });
  });

  test.each(["export", "watch", "applyUpdate", "_ctx", "_store", "_ds", "_pipeline", "constructor", "__proto__", "futureMethod"])(
    "rejects unapproved collection capability %s", async property => {
      const { db } = await setup();
      await db.transaction(async tx => {
        const col = tx.useCollection("items");
        expect(() => col[property]).toThrow(expect.objectContaining(directAccess));
        expect(property in col).toBe(false);
        expect(Object.getOwnPropertyDescriptor(col, property)).toBeUndefined();
      });
    }
  );

  test("prevents handle mutation and reflective access to backing state", async () => {
    const { db } = await setup();
    await db.transaction(async tx => {
      for (const handle of [tx, tx.useCollection("items")]) {
        expect(Object.getPrototypeOf(handle)).toBeNull();
        expect(() => { handle.escape = db; }).toThrow(expect.objectContaining(directAccess));
        expect(() => Object.defineProperty(handle, "escape", { value: db })).toThrow(expect.objectContaining(directAccess));
        expect(() => Object.setPrototypeOf(handle, db)).toThrow(expect.objectContaining(directAccess));
        expect(() => Object.preventExtensions(handle)).toThrow(expect.objectContaining(directAccess));
        expect(() => { delete handle.useCollection; }).toThrow(expect.objectContaining(directAccess));
      }
    });
  });

  test("retains generic helper reuse and expires reflected methods", async () => {
    const { db } = await setup();
    const add = (handle, id) => handle.useCollection("items").insertOne({ _id: id });
    await add(db, "outside");
    let factory, insert;
    const result = await db.transaction(async tx => {
      expect(await Promise.resolve(tx)).toBe(tx);
      expect(Object.keys(tx).sort()).toEqual(["createCollection", "useCollection"]);
      factory = Object.getOwnPropertyDescriptor(tx, "useCollection").value;
      const col = factory("items");
      expect(await Promise.resolve(col)).toBe(col);
      expect(col.name).toBe("items");
      insert = Object.getOwnPropertyDescriptor(col, "insertOne").value;
      await insert({ _id: "reflected" });
      await add(tx, "inside");
      return 42;
    });
    expect(result).toBe(42);
    expect(() => factory("items")).toThrow(expect.objectContaining({ code: "ERR_SKALEX_TX_STALE_PROXY" }));
    expect(() => insert({ _id: "late" })).toThrow(expect.objectContaining({ code: "ERR_SKALEX_TX_STALE_PROXY" }));
    expect(await db.useCollection("items").count()).toBe(4);
  });

  test("new database methods are not implicitly available in transactions", async () => {
    const { db } = await setup();
    let called = false;
    db.futureMethod = () => { called = true; };
    await db.transaction(async tx => {
      expect(() => tx.futureMethod()).toThrow(expect.objectContaining(directAccess));
    });
    expect(called).toBe(false);
  });

  test("migration callbacks receive the same restricted surface", async () => {
    const adapter = new MemoryAdapter();
    const db = new Skalex({ adapter });
    db.addMigration({ version: 1, up: async tx => {
      await tx.useCollection("items").insertOne({ _id: "owned" });
      await tx.saveData("items");
    } });
    await expect(db.connect()).rejects.toMatchObject(directAccess);
    expect(await adapter.read("items")).toBeNull();
  });
});
