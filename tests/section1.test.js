const path = require("path");
const fs = require("fs");
const Skalex = require("../src/index");

const TEST_DB_PATH = path.resolve(__dirname, ".test-db-s1");

function cleanup() {
  if (fs.existsSync(TEST_DB_PATH)) {
    fs.rmSync(TEST_DB_PATH, { recursive: true, force: true });
  }
}

beforeEach(cleanup);
afterAll(cleanup);

describe("Section 1 — P0 Critical Bugs", () => {
  // FIX-01: findOne returns newItem (with select/populate applied)
  test("FIX-01: findOne() returns projected document, not raw", async () => {
    const db = new Skalex({ path: TEST_DB_PATH });
    await db.connect();
    const users = db.useCollection("users");
    await users.insertOne({ name: "Alice", age: 30, role: "admin" });

    const doc = await users.findOne({ name: "Alice" }, { select: ["name"] });
    expect(Object.keys(doc)).toHaveLength(1);
    expect(doc.name).toBe("Alice");
    expect(doc.age).toBeUndefined();
    await db.disconnect();
  });

  // FIX-02: matchesFilter AND logic
  test("FIX-02: multi-condition AND filter works", async () => {
    const db = new Skalex({ path: TEST_DB_PATH });
    await db.connect();
    const users = db.useCollection("users");
    await users.insertOne({ name: "Alice", role: "admin", age: 30 });
    await users.insertOne({ name: "Bob", role: "admin", age: 25 });
    await users.insertOne({ name: "Carol", role: "user", age: 30 });

    const r1 = await users.find({ role: "admin", age: 30 });
    expect(r1.docs).toHaveLength(1);
    expect(r1.docs[0].name).toBe("Alice");
    await db.disconnect();
  });

  test("FIX-02: $in operator works correctly", async () => {
    const db = new Skalex({ path: TEST_DB_PATH });
    await db.connect();
    const users = db.useCollection("users");
    await users.insertOne({ name: "Alice", role: "admin" });
    await users.insertOne({ name: "Bob", role: "user" });
    await users.insertOne({ name: "Carol", role: "guest" });

    const r = await users.find({ role: { $in: ["admin", "user"] } });
    expect(r.docs).toHaveLength(2);
    await db.disconnect();
  });

  test("FIX-02: nested field filter works", async () => {
    const db = new Skalex({ path: TEST_DB_PATH });
    await db.connect();
    const users = db.useCollection("users");
    await users.insertOne({ name: "Test", address: { city: "Cairo" }, age: 25 });
    await users.insertOne({ name: "Test2", address: { city: "London" }, age: 25 });

    const r = await users.find({ "address.city": "Cairo", age: 25 });
    expect(r.docs).toHaveLength(1);
    expect(r.docs[0].name).toBe("Test");
    await db.disconnect();
  });

  test("FIX-02: falsy value (0) is not skipped", async () => {
    const db = new Skalex({ path: TEST_DB_PATH });
    await db.connect();
    const scores = db.useCollection("scores");
    await scores.insertOne({ player: "Bob", score: 0 });
    await scores.insertOne({ player: "Alice", score: 10 });

    const r = await scores.find({ score: 0 });
    expect(r.docs).toHaveLength(1);
    expect(r.docs[0].player).toBe("Bob");
    await db.disconnect();
  });

  // FIX-03: $inc and $push write back
  test("FIX-03: $inc increments the field value", async () => {
    const db = new Skalex({ path: TEST_DB_PATH });
    await db.connect();
    const users = db.useCollection("users");
    await users.insertOne({ name: "Alice", score: 10, tags: ["a"] });

    await users.updateOne({ name: "Alice" }, { score: { $inc: 5 } });
    const doc1 = await users.findOne({ name: "Alice" });
    expect(doc1.score).toBe(15);
    await db.disconnect();
  });

  test("FIX-03: $push adds element to array", async () => {
    const db = new Skalex({ path: TEST_DB_PATH });
    await db.connect();
    const users = db.useCollection("users");
    await users.insertOne({ name: "Alice", tags: ["a"] });

    await users.updateOne({ name: "Alice" }, { tags: { $push: "b" } });
    const doc = await users.findOne({ name: "Alice" });
    expect(doc.tags).toHaveLength(2);
    expect(doc.tags[1]).toBe("b");
    await db.disconnect();
  });

  // FIX-04: concurrent saves of separate collections
  test("FIX-04: concurrent saves of different collections both complete", async () => {
    const db = new Skalex({ path: TEST_DB_PATH, format: "json" });
    await db.connect();
    const users = db.useCollection("users");
    const orders = db.useCollection("orders");
    await users.insertOne({ name: "Alice" });
    await orders.insertOne({ item: "Widget" });

    await Promise.all([
      db.saveData("users"),
      db.saveData("orders"),
    ]);

    // Reload and verify both persisted
    await db.disconnect();
    const db2 = new Skalex({ path: TEST_DB_PATH, format: "json" });
    await db2.connect();
    expect(db2.collections.users).toBeDefined();
    expect(db2.collections.orders).toBeDefined();
    await db2.disconnect();
  });

  // FIX-05: no double serialisation
  test("FIX-05: save and reload produces objects, not strings", async () => {
    const db = new Skalex({ path: TEST_DB_PATH, format: "json" });
    await db.connect();
    const users = db.useCollection("users");
    await users.insertOne({ name: "Alice" });
    await db.saveData("users");
    await db.disconnect();

    const db2 = new Skalex({ path: TEST_DB_PATH, format: "json" });
    await db2.connect();
    const users2 = db2.useCollection("users");
    const doc = await users2.findOne({ name: "Alice" });
    expect(typeof doc).toBe("object");
    expect(doc.name).toBe("Alice");
    await db2.disconnect();
  });
});
