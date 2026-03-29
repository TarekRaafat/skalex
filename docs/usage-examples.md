# Usage Examples <!-- {docsify-ignore} -->

---

### 1. Basic CRUD

```javascript
import Skalex from "skalex";

const db = new Skalex({ path: "./data", format: "json" });
await db.connect();

const users = db.useCollection("users");

// Insert
const { data: user } = await users.insertOne({ name: "Alice", age: 30 });
console.log(user._id); // "0196f3a2b4c8d1e..."

// Find one
const doc = await users.findOne({ name: "Alice" });

// Find many with operators
const { docs } = await users.find({ age: { $gte: 18 } });

// Update
await users.updateOne({ name: "Alice" }, { age: 31 });
await users.updateOne({ name: "Alice" }, { score: { $inc: 10 } });
await users.updateOne({ name: "Alice" }, { tags: { $push: "vip" } });

// Delete
await users.deleteOne({ name: "Alice" });

await db.disconnect();
```

---

### 2. Schema Validation & Unique Constraints

```javascript
import Skalex from "skalex";

const db = new Skalex({ path: "./data" });

db.createCollection("users", {
  schema: {
    email: { type: "string", required: true, unique: true },
    role:  { type: "string", enum: ["admin", "user"], required: true },
    age:   "number",
  },
  indexes: ["role"],
});

await db.connect();

const users = db.useCollection("users");

// Valid insert
await users.insertOne({ email: "alice@example.com", role: "admin" });

// Throws — email already exists
await users.insertOne({ email: "alice@example.com", role: "user" });

// Throws — role is required
await users.insertOne({ email: "bob@example.com" });

await db.disconnect();
```

---

### 3. TTL Documents

```javascript
import Skalex from "skalex";

const db = new Skalex({ path: "./data" });
await db.connect();

const sessions = db.useCollection("sessions");

// Expires in 30 minutes
await sessions.insertOne({ userId: "abc123", token: "xyz" }, { ttl: "30m" });

// Expires in 1 day
await sessions.insertOne({ userId: "def456", token: "abc" }, { ttl: "1d" });

// On next connect(), any expired docs are swept automatically
await db.disconnect();
```

---

### 4. Migrations

```javascript
import Skalex from "skalex";

const db = new Skalex({ path: "./data" });

db.addMigration({
  version: 1,
  description: "Set default role on all users",
  up: async (col) => {
    await col.updateMany({}, { role: "user" });
  },
});

db.addMigration({
  version: 2,
  description: "Add active flag",
  up: async (col) => {
    await col.updateMany({}, { active: true });
  },
});

// Pending migrations run automatically on connect()
await db.connect();

console.log(db.migrationStatus());
// { current: 2, applied: [1, 2], pending: [] }

await db.disconnect();
```

---

### 5. Transactions

```javascript
import Skalex from "skalex";

const db = new Skalex({ path: "./data" });
await db.connect();

const accounts = db.useCollection("accounts");
await accounts.insertMany([
  { name: "Alice", balance: 500 },
  { name: "Bob",   balance: 200 },
]);

// Transfer 100 from Alice to Bob — rolls back if anything throws
await db.transaction(async (db) => {
  const accounts = db.useCollection("accounts");
  await accounts.updateOne({ name: "Alice" }, { balance: { $inc: -100 } });
  await accounts.updateOne({ name: "Bob" },   { balance: { $inc:  100 } });
});

await db.disconnect();
```

---

### 6. Upsert & ifNotExists

```javascript
import Skalex from "skalex";

const db = new Skalex({ path: "./data" });
await db.connect();

const settings = db.useCollection("settings");

// Insert if no match, update if found
await settings.upsert({ key: "theme" }, { value: "dark" });

// Insert only if no matching document exists
await settings.insertOne({ key: "theme", value: "light" }, { ifNotExists: true });

await db.disconnect();
```

---

### 7. Population & Projection

```javascript
import Skalex from "skalex";

const db = new Skalex({ path: "./data" });
await db.connect();

const users = db.useCollection("users");
const posts = db.useCollection("posts");

const { data: user } = await users.insertOne({ name: "Alice" });

await posts.insertMany([
  { title: "Hello World", users: user._id },
  { title: "Second Post", users: user._id },
]);

// Populate the "users" field with the related user document
const { docs } = await posts.find(
  { users: user._id },
  { populate: ["users"], select: ["title", "users"] }
);

console.log(docs[0].users.name); // "Alice"

await db.disconnect();
```

---

### 8. Sorting & Pagination

```javascript
import Skalex from "skalex";

const db = new Skalex({ path: "./data" });
await db.connect();

const products = db.useCollection("products");
await products.insertMany([
  { name: "Widget", price: 9.99 },
  { name: "Gadget", price: 24.99 },
  { name: "Doohickey", price: 4.99 },
]);

// Sort ascending by price
const { docs } = await products.find({}, { sort: { price: 1 } });

// Page 1, 2 results per page
const page1 = await products.find({}, { sort: { price: -1 }, page: 1, limit: 2 });
console.log(page1.totalDocs);  // 3
console.log(page1.totalPages); // 2

await db.disconnect();
```

---

### 9. Export & Import

```javascript
import Skalex from "skalex";

const db = new Skalex({ path: "./data", format: "json" });
await db.connect();

const users = db.useCollection("users");
await users.insertMany([{ name: "Alice" }, { name: "Bob" }]);

// Export to JSON
await users.export({}, { format: "json", dir: "./exports" });

// Export filtered subset to CSV
await users.export({ name: "Alice" }, { format: "csv", name: "admins" });

// Import from a JSON file (collection name derived from filename)
await db.import("./exports/users.json");

await db.disconnect();
```

---

### 10. Seeding & Inspection

```javascript
import Skalex from "skalex";

const db = new Skalex({ path: "./data" });
await db.connect();

// Seed with reset
await db.seed({
  users: [
    { name: "Alice", role: "admin" },
    { name: "Bob",   role: "user" },
  ],
  products: [
    { name: "Widget", price: 9.99 },
  ],
}, { reset: true });

// Inspect
console.log(db.inspect("users"));
// { name: "users", count: 2, schema: null, indexes: [] }

// Dump all data
const snapshot = db.dump();
console.log(snapshot.users.length); // 2

await db.disconnect();
```

---

### 11. Namespaced Instances

```javascript
import Skalex from "skalex";

const db = new Skalex({ path: "./data" });

// Each tenant gets isolated storage under ./data/<tenantId>
const tenant1 = db.namespace("tenant-001");
const tenant2 = db.namespace("tenant-002");

await tenant1.connect();
await tenant1.useCollection("orders").insertOne({ item: "Widget" });
await tenant1.disconnect();
```

---

### 12. Custom Storage Adapter (Browser)

```javascript
import Skalex from "skalex";
import { LocalStorageAdapter } from "skalex/adapters";

const db = new Skalex({
  adapter: new LocalStorageAdapter({ namespace: "myapp" }),
});

await db.connect();

const notes = db.useCollection("notes");
await notes.insertOne({ text: "Hello from the browser!" });

await db.disconnect();
```
