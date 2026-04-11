# Usage Examples <!-- {docsify-ignore} -->

---

### 1. Basic CRUD

```javascript
import Skalex from "skalex";

const db = new Skalex({ path: "./data", format: "json" });
await db.connect();

const users = db.useCollection("users");

// Insert
const user = await users.insertOne({ name: "Alice", age: 30 });
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

// Throws - email already exists
await users.insertOne({ email: "alice@example.com", role: "user" });

// Throws - role is required
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
  up: async (db) => {
    const users = db.useCollection("users");
    await users.updateMany({}, { role: "user" });
  },
});

db.addMigration({
  version: 2,
  description: "Add active flag",
  up: async (db) => {
    const users = db.useCollection("users");
    await users.updateMany({}, { active: true });
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

// Transfer 100 from Alice to Bob - rolls back if anything throws
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

const user = await users.insertOne({ name: "Alice" });

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
import { LocalStorageAdapter } from "skalex/connectors/storage";

const db = new Skalex({
  adapter: new LocalStorageAdapter({ namespace: "myapp" }),
});

await db.connect();

const notes = db.useCollection("notes");
await notes.insertOne({ text: "Hello from the browser!" });

await db.disconnect();
```

---

### 13. Semantic Search

```javascript
import Skalex from "skalex";

const db = new Skalex({
  path: "./data",
  ai: {
    provider: "openai",
    apiKey: process.env.OPENAI_KEY,
  },
});
await db.connect();

const articles = db.useCollection("articles");

// Insert documents - embed the "content" field automatically
await articles.insertMany([
  { title: "Getting started with Skalex", content: "Skalex is a zero-dependency JS database..." },
  { title: "Vector search explained",     content: "Cosine similarity measures the angle between two vectors..." },
  { title: "Using Ollama locally",         content: "Ollama lets you run embedding models on your own machine..." },
], { embed: "content" });

// Search by meaning - returns docs ranked by cosine similarity
const { docs, scores } = await articles.search("how do I set up a local database?", { limit: 2 });

console.log(docs[0].title); // most relevant article
console.log(scores[0]);     // e.g. 0.91

await db.disconnect();
```

---

### 14. Hybrid Search & Nearest Neighbours

```javascript
import Skalex from "skalex";

const db = new Skalex({
  path: "./data",
  ai: { provider: "ollama", embedModel: "nomic-embed-text" },
});
await db.connect();

const docs = db.useCollection("docs");

await docs.insertMany([
  { text: "JavaScript async patterns",  category: "js" },
  { text: "TypeScript generics guide",  category: "ts" },
  { text: "Python async with asyncio",  category: "py" },
  { text: "Node.js streams tutorial",   category: "js" },
], { embed: "text" });

// Hybrid: vector similarity filtered to a specific category
const { docs: results } = await docs.search("async programming", {
  filter: { category: "js" },
  limit: 5,
  minScore: 0.5,
});

// Find documents similar to an existing one
const source = await docs.findOne({ text: "JavaScript async patterns" });
const { docs: similar, scores } = await docs.similar(source._id, { limit: 2 });

console.log(similar[0].text); // "Node.js streams tutorial"

await db.disconnect();
```

---

### 15. Encryption at Rest

```javascript
import Skalex from "skalex";

const db = new Skalex({
  path: "./data",
  encrypt: { key: process.env.DB_KEY }, // 64-char hex or 32-byte Uint8Array
});
await db.connect();

const secrets = db.useCollection("secrets");
await secrets.insertOne({ apiKey: "sk-...", service: "openai" });

// Files on disk are AES-256-GCM encrypted - unreadable without the key
await db.disconnect();
```

---

### 16. Natural Language Queries (`db.ask`)

```javascript
import Skalex from "skalex";

const db = new Skalex({
  path: "./data",
  ai: {
    provider: "openai",
    apiKey: process.env.OPENAI_KEY,
    embedModel: "text-embedding-3-small",
    model: "gpt-4o-mini",
  },
});
await db.connect();

const users = db.useCollection("users");
await users.insertMany([
  { name: "Alice", role: "admin", dept: "engineering", age: 32 },
  { name: "Bob",   role: "user",  dept: "marketing",   age: 27 },
  { name: "Carol", role: "admin", dept: "engineering",  age: 41 },
]);

// Translate natural language → structured filter → run find()
const { docs } = await db.ask("users", "find all admins in engineering over 30");

console.log(docs.map(d => d.name)); // ["Alice", "Carol"]

await db.disconnect();
```

---

### 17. Agent Memory

```javascript
import Skalex from "skalex";

const db = new Skalex({
  path: "./data",
  ai: {
    provider: "openai",
    apiKey: process.env.OPENAI_KEY,
    embedModel: "text-embedding-3-small",
    model: "gpt-4o-mini",
  },
});
await db.connect();

const memory = db.useMemory("session-abc");

// Store episodic memories
await memory.remember("User's name is Alice");
await memory.remember("User prefers dark mode");
await memory.remember("User's primary language is JavaScript");

// Semantic recall
const { docs } = await memory.recall("user display preferences", { limit: 3 });
console.log(docs[0].text); // "User prefers dark mode"

// LLM-ready context string (capped to token budget)
const ctx = memory.context({ tokens: 500 });
// "User's name is Alice\nUser prefers dark mode\n..."

// Compress old memories to save tokens
await memory.compress({ threshold: 20 });

await db.disconnect();
```

---

### 18. ChangeLog & Point-in-Time Restore

```javascript
import Skalex from "skalex";

const db = new Skalex({ path: "./data" });

// Enable mutation log on the orders collection
db.createCollection("orders", { changelog: true });

await db.connect();

const orders = db.useCollection("orders");

await orders.insertOne({ item: "Widget", qty: 5 }, { session: "user-123" });
const snapshot = new Date();

await orders.updateOne({ item: "Widget" }, { qty: 99 });

// Query the audit log
const log = await db.changelog().query("orders");
console.log(log[0].op);      // "insert"
console.log(log[0].session); // "user-123"

// Restore the entire collection to the state at `snapshot`
await db.restore("orders", snapshot);

const { docs } = await orders.find({});
console.log(docs[0].qty); // 5 - update rolled back

await db.disconnect();
```

---

### 19. Aggregation

```javascript
import Skalex from "skalex";

const db = new Skalex({ path: "./data" });
await db.connect();

const orders = db.useCollection("orders");
await orders.insertMany([
  { product: "Widget", amount: 29.99, status: "paid"    },
  { product: "Gadget", amount: 99.99, status: "pending" },
  { product: "Widget", amount: 29.99, status: "paid"    },
  { product: "Doohickey", amount: 9.99, status: "paid"  },
]);

console.log(await orders.count());                           // 4
console.log(await orders.count({ status: "paid" }));         // 3
console.log(await orders.sum("amount"));                     // 169.96
console.log(await orders.sum("amount", { status: "paid" })); // 69.97
console.log(await orders.avg("amount"));                     // 42.49

const groups = await orders.groupBy("product");
console.log(groups.Widget.length); // 2

await db.disconnect();
```

---

### 20. Reactive Queries (`watch`)

```javascript
import Skalex from "skalex";

const db = new Skalex({ path: "./data" });
await db.connect();

const tasks = db.useCollection("tasks");

// Callback form - fires on every mutation
const unsub = tasks.watch((event) => {
  console.log(`[${event.op}]`, event.doc.title);
});

await tasks.insertOne({ title: "Buy milk", done: false });
// logs: [insert] Buy milk

await tasks.updateOne({ title: "Buy milk" }, { done: true });
// logs: [update] Buy milk

unsub(); // stop listening

// Filtered watch - only fires for incomplete tasks
const unsub2 = tasks.watch({ done: false }, (event) => {
  console.log("Incomplete task changed:", event.doc.title);
});

// AsyncIterator form
async function streamChanges() {
  const iter = tasks.watch();
  for await (const event of iter) {
    console.log(event.op, event.doc);
    if (event.doc.title === "STOP") await iter.return();
  }
}

await db.disconnect();
```

---

### 21. MCP Server for AI Agents

```javascript
import Skalex from "skalex";

const db = new Skalex({
  path: "./data",
  ai: {
    provider: "openai",
    apiKey: process.env.OPENAI_KEY,
    embedModel: "text-embedding-3-small",
    model: "gpt-4o-mini",
  },
});
await db.connect();

const products = db.useCollection("products");
await products.insertMany([
  { name: "Widget", price: 9.99,  category: "tools" },
  { name: "Gadget", price: 49.99, category: "electronics" },
], { embed: "name" });

// stdio transport - for Claude Desktop / Cursor
const server = db.mcp({
  scopes: {
    "products": ["read"],  // AI agents can only read
    "*":        ["read"],
  },
});

await server.listen(); // blocks on stdin
```

```json
// claude_desktop_config.json
{
  "mcpServers": {
    "skalex": {
      "command": "node",
      "args": ["./mcp-server.js"]
    }
  }
}
```

---

### 22. TypeScript Typed Collections

```typescript
import Skalex from "skalex";
import type { Collection } from "skalex";

// Define your document shape
interface User {
  name: string;
  email: string;
  role: "admin" | "user";
  age?: number;
}

interface Order {
  userId: string;
  product: string;
  amount: number;
  status: "pending" | "paid" | "cancelled";
}

const db = new Skalex({ path: "./data" });

db.createCollection("users", {
  schema: {
    email: { type: "string", required: true, unique: true },
    role:  { type: "string", enum: ["admin", "user"], required: true },
  },
  indexes: ["role"],
});

await db.connect();

// Typed collection - all methods infer from User
const users: Collection<User> = db.useCollection<User>("users");
const orders: Collection<Order> = db.useCollection<Order>("orders");

// insertOne returns User & { _id: string; createdAt: Date; updatedAt: Date }
const alice = await users.insertOne({
  name: "Alice",
  email: "alice@example.com",
  role: "admin",
  age: 32,
});

console.log(alice._id);   // string
console.log(alice.role);  // "admin"

// find returns { docs: Array<User & SystemFields>, ... }
const { docs } = await users.find({ role: "admin" });

// TypeScript catches bad fields at compile time
// await users.insertOne({ name: "Bob", role: "superuser" }); // TS error: not assignable

await orders.insertOne({
  userId: alice._id,
  product: "Widget",
  amount: 9.99,
  status: "pending",
});

await db.disconnect();
```

---

### 23. Error Handling

```javascript
import Skalex from "skalex";

const db = new Skalex({ path: "./data" });

db.createCollection("users", {
  schema: {
    email: { type: "string", required: true, unique: true },
    role:  { type: "string", enum: ["admin", "user"], required: true },
  },
});

await db.connect();
const users = db.useCollection("users");

// ── Schema validation errors ───────────────────────────────────────────────
try {
  await users.insertOne({ email: "alice@example.com" }); // missing required: role
} catch (err) {
  console.error(err.message); // "Validation error: 'role' is required"
}

try {
  await users.insertOne({ email: "alice@example.com", role: "superuser" }); // invalid enum
} catch (err) {
  console.error(err.message); // "Validation error: 'role' must be one of [admin, user]"
}

// ── Unique constraint violations ───────────────────────────────────────────
await users.insertOne({ email: "alice@example.com", role: "admin" });

try {
  await users.insertOne({ email: "alice@example.com", role: "user" }); // duplicate email
} catch (err) {
  console.error(err.message); // "Unique constraint violated: 'email' already exists"
}

// ── Transaction rollback ───────────────────────────────────────────────────
const accounts = db.useCollection("accounts");
await accounts.insertMany([
  { name: "Alice", balance: 100 },
  { name: "Bob",   balance: 50  },
]);

try {
  await db.transaction(async (db) => {
    const accounts = db.useCollection("accounts");
    await accounts.updateOne({ name: "Alice" }, { balance: { $inc: -200 } });
    // Simulate a business rule check
    const alice = await accounts.findOne({ name: "Alice" });
    if (alice.balance < 0) throw new Error("Insufficient funds");
  });
} catch (err) {
  console.error(err.message); // "Insufficient funds"
  // Alice's balance is fully restored - transaction rolled back
}

await db.disconnect();
```

---

### 24. Plugin System

```javascript
import Skalex from "skalex";
import { writeFile, appendFile } from "node:fs/promises";

// ── Audit plugin - logs every write to a file ──────────────────────────────
const auditPlugin = {
  async afterInsert({ collection, doc }) {
    const line = `${new Date().toISOString()} INSERT ${collection} ${doc._id}\n`;
    await appendFile("./audit.log", line);
  },
  async afterUpdate({ collection, result }) {
    const line = `${new Date().toISOString()} UPDATE ${collection} ${result?._id}\n`;
    await appendFile("./audit.log", line);
  },
  async afterDelete({ collection, result }) {
    const line = `${new Date().toISOString()} DELETE ${collection} ${result?._id}\n`;
    await appendFile("./audit.log", line);
  },
};

// ── Validation plugin - block inserts that fail a business rule ────────────
const validationPlugin = {
  async beforeInsert({ collection, doc }) {
    if (collection === "orders" && doc.amount <= 0) {
      throw new Error("Order amount must be greater than zero");
    }
  },
};

// ── Read-only plugin - log all finds for debugging ─────────────────────────
const debugPlugin = {
  async afterFind({ collection, filter, docs }) {
    console.log(`[find] ${collection} matched ${docs.length} doc(s)`, filter);
  },
};

const db = new Skalex({ path: "./data" });
await db.connect();

db.use(validationPlugin);
db.use(auditPlugin);
db.use(debugPlugin);

const orders = db.useCollection("orders");

// Passes validation - audit entry written
await orders.insertOne({ product: "Widget", amount: 9.99 });

try {
  // Fails beforeInsert - nothing written, no audit entry
  await orders.insertOne({ product: "Bad", amount: 0 });
} catch (err) {
  console.error(err.message); // "Order amount must be greater than zero"
}

// debugPlugin logs: [find] orders matched 1 doc(s) {}
await orders.find({});

await db.disconnect();
```

---

### 25. Session Stats

```javascript
import Skalex from "skalex";

const db = new Skalex({ path: "./data" });
await db.connect();

const posts = db.useCollection("posts");

// Simulate two users performing operations tagged with their session IDs
await posts.insertOne({ title: "Hello" },          { session: "user-alice" });
await posts.insertOne({ title: "World" },          { session: "user-alice" });
await posts.updateOne({ title: "Hello" }, { title: "Hi" }, { session: "user-alice" });

await posts.find({},                               { session: "user-bob" });
await posts.find({ title: "Hi" },                 { session: "user-bob" });

// Per-session stats
const alice = db.sessionStats("user-alice");
console.log(alice.writes);     // 3
console.log(alice.reads);      // 0
console.log(alice.lastActive); // Date

const bob = db.sessionStats("user-bob");
console.log(bob.writes);       // 0
console.log(bob.reads);        // 2

// All sessions - useful for a dashboard or rate-limiter
const all = db.sessionStats();
console.log(all.length);            // 2
console.log(all.map(s => s.sessionId)); // ["user-alice", "user-bob"]

await db.disconnect();
```

---

### 26. Slow Query Log

```javascript
import Skalex from "skalex";

const db = new Skalex({
  path: "./data",
  slowQueryLog: {
    threshold:  20,   // record queries that take longer than 20ms
    maxEntries: 500,  // keep the last 500 slow entries (ring buffer)
  },
});
await db.connect();

const logs = db.useCollection("logs");

// Insert a large batch to create measurable query times
await logs.insertMany(
  Array.from({ length: 5000 }, (_, i) => ({
    level: i % 3 === 0 ? "error" : "info",
    message: `Log entry ${i}`,
    ts: new Date(Date.now() - i * 1000),
  }))
);

// Run a query with no index - likely to exceed threshold on large collections
await logs.find({ level: "error", message: { $regex: /entry 1/ } });

// Retrieve slow query entries
const slow = db.slowQueries({ minDuration: 20, limit: 10 });

for (const entry of slow) {
  console.log(
    `[${entry.collection}] ${entry.op} - ${entry.duration}ms`,
    entry.filter ?? entry.query
  );
}

// Identify unindexed fields causing slowness, then add an index:
// db.createCollection("logs", { indexes: ["level"] });

await db.disconnect();
```
