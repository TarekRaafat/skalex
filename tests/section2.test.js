const path = require("path");
const fs = require("fs");
const Skalex = require("../src/index");

const TEST_DB_PATH = path.resolve(__dirname, ".test-db-s2");

function cleanup() {
  if (fs.existsSync(TEST_DB_PATH)) {
    fs.rmSync(TEST_DB_PATH, { recursive: true, force: true });
  }
}

beforeEach(cleanup);
afterAll(cleanup);

describe("Section 2 — P0 Logic Errors", () => {
  // FIX-06: findOne _id fast path
  test("FIX-06: findOne with _id uses Map index", async () => {
    const db = new Skalex({ path: TEST_DB_PATH });
    await db.connect();
    const users = db.useCollection("users");
    const { data: inserted } = await users.insertOne({ name: "Alice" });

    const doc = await users.findOne({ _id: inserted._id });
    expect(doc._id).toBe(inserted._id);
    expect(doc.name).toBe("Alice");
    await db.disconnect();
  });

  test("FIX-06: findOne with general filter still works", async () => {
    const db = new Skalex({ path: TEST_DB_PATH });
    await db.connect();
    const users = db.useCollection("users");
    await users.insertOne({ name: "Alice" });

    const doc = await users.findOne({ name: "Alice" });
    expect(doc.name).toBe("Alice");
    await db.disconnect();
  });

  // FIX-07: nested null traversal (covered by FIX-02 rewrite)
  test("FIX-07: nested filter on missing intermediate does not crash", async () => {
    const db = new Skalex({ path: TEST_DB_PATH });
    await db.connect();
    const users = db.useCollection("users");
    await users.insertOne({ name: "Alice" }); // no address field

    const r = await users.find({ "address.city": "Cairo" });
    expect(r.docs).toHaveLength(0);
    await db.disconnect();
  });

  // FIX-08: $in/$nin correct semantics (covered by FIX-02 rewrite)
  test("FIX-08: $nin operator works correctly", async () => {
    const db = new Skalex({ path: TEST_DB_PATH });
    await db.connect();
    const users = db.useCollection("users");
    await users.insertOne({ name: "Alice", role: "admin" });
    await users.insertOne({ name: "Bob", role: "user" });
    await users.insertOne({ name: "Carol", role: "guest" });

    const r = await users.find({ role: { $nin: ["admin", "guest"] } });
    expect(r.docs).toHaveLength(1);
    expect(r.docs[0].name).toBe("Bob");
    await db.disconnect();
  });

  test("FIX-08: RegExp as direct filter value works", async () => {
    const db = new Skalex({ path: TEST_DB_PATH });
    await db.connect();
    const users = db.useCollection("users");
    await users.insertOne({ name: "Alice", email: "alice@test.com" });
    await users.insertOne({ name: "Bob", email: "bob@test.com" });

    const r = await users.find({ email: /alice/i });
    expect(r.docs).toHaveLength(1);
    expect(r.docs[0].name).toBe("Alice");
    await db.disconnect();
  });
});
