# Documentation <!-- {docsify-ignore} -->

---

## Class: Skalex

The main database class. Manages collections, persistence, migrations, and transactions.

### Constructor

```javascript
new Skalex(config?)
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `path` | `string` | `"./.db"` | Data directory path |
| `format` | `"gz" \| "json"` | `"gz"` | Storage format. `"gz"` = compressed, `"json"` = plain |
| `debug` | `boolean` | `false` | Log connect/disconnect output |
| `adapter` | `StorageAdapter` | `FsAdapter` | Custom storage backend |
| `ai` | `object` | `undefined` | AI / embedding config — see [Embedding Adapters](#embedding-adapters) and [Language Model Adapters](#language-model-adapters) |
| `encrypt` | `object` | `undefined` | At-rest encryption — see [Encryption](#encryption) |
| `slowQueryLog` | `object` | `undefined` | Slow query recording — see [Slow Query Log](#slow-query-log) |

```javascript
const db = new Skalex({ path: "./data", format: "json" });
```

```javascript
// With AI (enables vector search + natural language queries)
const db = new Skalex({
  path: "./data",
  ai: {
    provider: "openai",
    apiKey: process.env.OPENAI_KEY,
    embedModel: "text-embedding-3-small", // default — for insertOne/search
    model: "gpt-4o-mini",                 // for db.ask() and memory.compress()
  },
});
```

```javascript
// With encryption at rest
const db = new Skalex({
  path: "./data",
  encrypt: { key: process.env.DB_KEY }, // 64-char hex or 32-byte Uint8Array
});
```

```javascript
// With slow query logging
const db = new Skalex({
  path: "./data",
  slowQueryLog: { threshold: 50, maxEntries: 1000 },
});
```

---

### Connection

#### `connect()`

Loads persisted data, runs pending migrations, sweeps expired TTL documents.

**Returns:** `Promise<void>`

#### `disconnect()`

Flushes all unsaved data to the storage adapter, clears in-memory state.

**Returns:** `Promise<void>`

---

### Collections

#### `useCollection(name)`

Returns a cached `Collection` instance. Creates the collection if it does not exist.

**Returns:** `Collection`

#### `createCollection(name, options?)`

Defines a collection with optional schema and secondary indexes. Call before `connect()` to ensure schema is applied when loading persisted data.

| Option | Type | Description |
|--------|------|-------------|
| `schema` | `object` | Schema definition — see [Schema Validation](#schema-validation) |
| `indexes` | `string[]` | Fields to build secondary (non-unique) indexes on |
| `changelog` | `boolean` | Enable append-only mutation log for this collection |

**Returns:** `Collection`

```javascript
const users = db.createCollection("users", {
  schema: {
    email: { type: "string", required: true, unique: true },
    role:  { type: "string", enum: ["admin", "user"] },
  },
  indexes: ["role"],
});
```

---

### Persistence

#### `saveData(collectionName?)`

Persists one collection (or all, if no name given) via the storage adapter.

**Returns:** `Promise<void>`

---

### Migrations

#### `addMigration({ version, description?, up })`

Registers a migration. Pending migrations run automatically on `connect()` in version order.

```javascript
db.addMigration({
  version: 1,
  description: "Add default role to all users",
  up: async (col) => {
    await col.updateMany({}, { role: "user" });
  },
});
```

#### `migrationStatus()`

**Returns:** `{ current: number, applied: number[], pending: number[] }`

---

### Transactions

#### `transaction(fn)`

Runs `fn` inside a transaction. On success, all changes are flushed to storage. On error, all in-memory state is rolled back to the pre-transaction snapshot.

**Returns:** `Promise<any>` — the return value of `fn`

```javascript
await db.transaction(async (db) => {
  const accounts = db.useCollection("accounts");
  await accounts.updateOne({ name: "Alice" }, { balance: { $inc: -100 } });
  await accounts.updateOne({ name: "Bob" },   { balance: { $inc:  100 } });
});
```

---

### Seeding & Utilities

#### `seed(fixtures, options?)`

Seeds collections with fixture data. Pass `{ reset: true }` to clear before seeding.

```javascript
await db.seed({
  users: [{ name: "Alice", role: "admin" }, { name: "Bob", role: "user" }],
}, { reset: true });
```

#### `dump()`

Returns a plain-object snapshot of all collection data.

**Returns:** `Record<string, Document[]>`

#### `inspect(collectionName?)`

Returns metadata about one or all collections.

**Returns:** `{ name, count, schema, indexes }` or a map of all collections.

#### `namespace(id)`

Returns a new `Skalex` instance scoped to a sub-directory of the current data path.

**Returns:** `Skalex`

#### `embed(text)`

Embeds a text string using the configured AI adapter.

**Returns:** `Promise<number[]>`

Throws if no `ai` config was provided to the constructor.

```javascript
const vector = await db.embed("zero-dependency JS database");
```

#### `import(filePath, format?)`

Imports documents from a JSON or CSV file. The collection name is derived from the file name.

**Returns:** `Promise<{ docs: Document[] }>`

---

### AI Query

#### `ask(collectionName, nlQuery, options?)`

Translates a natural language query into a structured filter via the configured language model, then runs `find()` on the target collection. Results are cached by a hash of `{ collection, schema, query }` and persisted across connect/disconnect cycles.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `limit` | `number` | `10` | Maximum results |

**Returns:** `Promise<{ docs: Document[], page?, totalDocs?, totalPages? }>`

Requires `ai` config with a `model` that supports chat completions.

```javascript
const { docs } = await db.ask("users", "find all admins in the engineering department");
```

#### `schema(collectionName)`

Returns the declared schema for a collection, or an inferred `{ field: type }` map from existing documents. Returns `null` if the collection is empty and has no declared schema.

**Returns:** `Record<string, string> | null`

```javascript
const schema = db.schema("users");
// { name: "string", age: "number", role: "string" }
```

---

### Agent Memory

#### `useMemory(sessionId)`

Returns a `Memory` instance scoped to the given session. Backed by a `_memory_<sessionId>` collection. Requires `ai` config with both embedding and language model.

**Returns:** `Memory`

```javascript
const memory = db.useMemory("session-abc");
await memory.remember("User prefers dark mode");
const { docs } = await memory.recall("display preferences");
```

See [Class: Memory](#class-memory) for the full API.

---

### ChangeLog

#### `changelog()`

Returns the shared `ChangeLog` instance. Only available when at least one collection was created with `{ changelog: true }`.

**Returns:** `ChangeLog`

#### `restore(collectionName, timestamp, options?)`

Replays the changelog to rebuild a collection's state at a point in time.

| Option | Type | Description |
|--------|------|-------------|
| `_id` | `string` | Restore only a single document |

**Returns:** `Promise<void>`

```javascript
await db.restore("orders", "2025-01-01T00:00:00Z");
```

---

### Stats & Observability

#### `stats(collectionName?)`

Returns usage statistics for one or all collections.

**Returns:** `{ collection, count, estimatedSize, avgDocSize }` or an array of all.

```javascript
const s = db.stats("users");
// { collection: "users", count: 42, estimatedSize: 8192, avgDocSize: 195 }

const all = db.stats();
// [{ collection: "users", ... }, { collection: "orders", ... }]
```

#### `slowQueries(options?)`

Returns recorded slow queries.

| Option | Type | Description |
|--------|------|-------------|
| `limit` | `number` | Maximum entries to return |
| `minDuration` | `number` | Minimum duration in ms |
| `collection` | `string` | Filter by collection name |

**Returns:** `SlowQueryEntry[]`

Each entry: `{ collection, op, filter?, query?, duration, resultCount, timestamp }`

---

### MCP Server

#### `mcp(options?)`

Creates and returns a `SkalexMCPServer` that exposes the database as MCP tools for AI agents.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `transport` | `"stdio" \| "http"` | `"stdio"` | Transport type |
| `port` | `number` | `3000` | HTTP port (http transport only) |
| `host` | `string` | `"127.0.0.1"` | HTTP host (http transport only) |
| `scopes` | `object` | `{ "*": ["read","write"] }` | Access control per collection |

**Returns:** `SkalexMCPServer`

See [Class: SkalexMCPServer](#class-skalexmcpserver) for details.

```javascript
// Claude Desktop / Cursor — stdio transport
const server = db.mcp();
await server.listen();
```

```javascript
// HTTP + SSE transport with access control
const server = db.mcp({
  transport: "http",
  port: 4000,
  scopes: {
    "public": ["read"],
    "orders": ["read", "write"],
    "*":      ["read"],
  },
});
await server.listen();
```

---

## Class: Collection

Represents a collection of documents. Obtained via `db.useCollection()` or `db.createCollection()`.

---

### Insert

#### `insertOne(document, options?)`

| Option | Type | Description |
|--------|------|-------------|
| `save` | `boolean` | Immediately persist after insert |
| `ifNotExists` | `boolean` | Return the existing doc if a match is found — no duplicate inserted |
| `ttl` | `number \| string` | Set expiry: number = seconds, or `"30m"`, `"24h"`, `"7d"` |
| `embed` | `string \| Function` | Field name (or selector fn) whose value is embedded and stored as `_vector` |
| `session` | `string` | Session ID for audit trail (passed to changelog) |

**Returns:** `Promise<{ data: Document }>`

```javascript
const { data } = await users.insertOne({ name: "Alice" }, { ttl: "24h" });
const { data } = await users.insertOne({ name: "Bob" }, { session: "user-123" });
```

#### `insertMany(documents, options?)`

| Option | Type | Description |
|--------|------|-------------|
| `save` | `boolean` | Immediately persist after insert |
| `ttl` | `number \| string` | Set expiry on all inserted documents |
| `embed` | `string \| Function` | Field name (or selector fn) whose value is embedded and stored as `_vector` |
| `session` | `string` | Session ID for audit trail |

**Returns:** `Promise<{ docs: Document[] }>`

---

### Update

#### `updateOne(filter, update, options?)`

Updates the first matching document. Supports `$inc` and `$push` operators.

| Option | Type | Description |
|--------|------|-------------|
| `save` | `boolean` | Immediately persist after update |
| `session` | `string` | Session ID for audit trail |

**Returns:** `Promise<{ data: Document } | null>`

```javascript
await users.updateOne({ name: "Alice" }, { score: { $inc: 10 } });
await users.updateOne({ name: "Alice" }, { tags:  { $push: "vip" } });
```

#### `updateMany(filter, update, options?)`

Updates all matching documents.

| Option | Type | Description |
|--------|------|-------------|
| `save` | `boolean` | Immediately persist after update |
| `session` | `string` | Session ID for audit trail |

**Returns:** `Promise<{ docs: Document[] }>`

#### `upsert(filter, doc, options?)`

Updates the first match, or inserts `{ ...filter, ...doc }` if no match is found.

| Option | Type | Description |
|--------|------|-------------|
| `session` | `string` | Session ID for audit trail |

**Returns:** `Promise<{ data: Document }>`

---

### Find

#### `findOne(filter, options?)`

| Option | Type | Description |
|--------|------|-------------|
| `populate` | `string[]` | Collection names to join on the matching field |
| `select` | `string[]` | Fields to include in the returned document |

**Returns:** `Promise<Document | null>`

#### `find(filter, options?)`

| Option | Type | Description |
|--------|------|-------------|
| `populate` | `string[]` | Collection names to join |
| `select` | `string[]` | Fields to include |
| `sort` | `object` | `{ field: 1 }` ascending, `{ field: -1 }` descending |
| `page` | `number` | Page number (requires `limit`) |
| `limit` | `number` | Documents per page |

**Returns:** `Promise<{ docs, page?, totalDocs?, totalPages? }>`

---

### Delete

#### `deleteOne(filter, options?)`

| Option | Type | Description |
|--------|------|-------------|
| `save` | `boolean` | Immediately persist after delete |
| `session` | `string` | Session ID for audit trail |

**Returns:** `Promise<{ data: Document } | null>`

#### `deleteMany(filter, options?)`

| Option | Type | Description |
|--------|------|-------------|
| `save` | `boolean` | Immediately persist after delete |
| `session` | `string` | Session ID for audit trail |

**Returns:** `Promise<{ docs: Document[] }>`

---

### Export

#### `export(filter?, options?)`

Exports matched documents to JSON or CSV via the storage adapter.

| Option | Type | Description |
|--------|------|-------------|
| `dir` | `string` | Export directory (default: `<dataDirectory>/exports`) |
| `name` | `string` | Output file name (default: collection name) |
| `format` | `"json" \| "csv"` | Output format (default: `"json"`) |

**Throws:** `Error` if no documents match the filter.

---

### Vector Search

#### `search(query, options?)`

Embeds `query` using the configured AI adapter and ranks all documents that have a `_vector` field by cosine similarity. The `_vector` field is never returned in results.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `filter` | `object` | `undefined` | Structured pre-filter applied before scoring (hybrid search) |
| `limit` | `number` | `10` | Maximum number of results |
| `minScore` | `number` | `0` | Minimum cosine similarity score — range [-1, 1] |

**Returns:** `Promise<{ docs: Document[], scores: number[] }>`

Requires `ai` config on the `Skalex` constructor.

```javascript
const { docs, scores } = await articles.search("how to set up a database", { limit: 5 });
console.log(docs[0].title); // most semantically relevant article
console.log(scores[0]);     // e.g. 0.94
```

#### `similar(id, options?)`

Finds the nearest neighbours to an existing document by its `_vector`. The source document is excluded from results.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `limit` | `number` | `10` | Maximum number of results |
| `minScore` | `number` | `0` | Minimum cosine similarity score |

**Returns:** `Promise<{ docs: Document[], scores: number[] }>`

```javascript
const { docs } = await articles.similar(article._id, { limit: 3 });
```

Returns `{ docs: [], scores: [] }` if the document is not found or has no `_vector`.

---

### Aggregation

#### `count(filter?)`

**Returns:** `Promise<number>`

```javascript
const total  = await users.count();
const admins = await users.count({ role: "admin" });
```

#### `sum(field, filter?)`

Sums a numeric field across all matched documents. Non-numeric values are skipped. Supports dot-notation.

**Returns:** `Promise<number>`

```javascript
const total = await orders.sum("amount");
const paid  = await orders.sum("amount", { status: "paid" });
```

#### `avg(field, filter?)`

Returns the average of a numeric field, or `null` if there are no numeric values.

**Returns:** `Promise<number | null>`

```javascript
const avg = await scores.avg("value");
```

#### `groupBy(field, filter?)`

Groups documents by field value. `null` and `undefined` values are grouped under `"__null__"`. Supports dot-notation.

**Returns:** `Promise<Record<string, Document[]>>`

```javascript
const groups = await users.groupBy("role");
// { admin: [...], user: [...] }
```

---

### Reactive

#### `watch(filter?, callback?)`

Observe mutations on a collection. Fires after every `insertOne`, `insertMany`, `updateOne`, `updateMany`, `deleteOne`, `deleteMany`.

Event shape: `{ op: "insert"|"update"|"delete", collection, doc, prev? }`

**Callback form** — returns an unsubscribe function:

```javascript
const unsub = users.watch((event) => {
  console.log(event.op, event.doc.name);
});

// With a filter — only fires when doc matches
const unsub = users.watch({ role: "admin" }, (event) => {
  console.log("Admin changed:", event.doc);
});

unsub(); // stop watching
```

**AsyncIterableIterator form** — no callback:

```javascript
const iter = users.watch();
for await (const event of iter) {
  console.log(event.op, event.doc);
  if (done) await iter.return(); // clean up
}
```

---

## Query Filters

Filters can be a plain object, a function, or an empty object (matches all).

```javascript
// Exact match
await users.find({ role: "admin" });

// Query operators
await users.find({ age: { $gte: 18, $lt: 65 } });
await users.find({ role: { $in: ["admin", "moderator"] } });
await users.find({ role: { $nin: ["banned"] } });

// Regular expression (direct or $regex)
await users.find({ email: /alice/i });
await users.find({ email: { $regex: /^alice/ } });

// Custom function
await users.find({ age: { $fn: v => v % 2 === 0 } });

// Function filter
await users.find(doc => doc.score > 100);

// Dot-notation for nested fields
await users.find({ "address.city": "Cairo" });
```

| Operator | Description |
|----------|-------------|
| `$eq` | Equal |
| `$ne` | Not equal |
| `$gt` | Greater than |
| `$gte` | Greater than or equal |
| `$lt` | Less than |
| `$lte` | Less than or equal |
| `$in` | Value is in array |
| `$nin` | Value is not in array |
| `$regex` | Matches RegExp |
| `$fn` | Passes custom function |

---

## Schema Validation

Define schemas on `createCollection()`. Validation runs at insert and update time.

```javascript
db.createCollection("products", {
  schema: {
    name:     { type: "string",  required: true },
    price:    { type: "number",  required: true },
    category: { type: "string",  enum: ["electronics", "clothing", "food"] },
    sku:      { type: "string",  unique: true },
    active:   "boolean",
    tags:     "array",
    meta:     "any",
  },
});
```

**Supported types:** `"string"`, `"number"`, `"boolean"`, `"object"`, `"array"`, `"date"`, `"any"`

| Field option | Type | Description |
|---|---|---|
| `type` | `string` | Value type |
| `required` | `boolean` | Reject insert if field is missing |
| `unique` | `boolean` | Enforce no-duplicate constraint |
| `enum` | `any[]` | Restrict to a set of allowed values |

---

## Storage Adapters

All I/O is routed through a `StorageAdapter`. Swap adapters to target different environments.

```javascript
// Node.js (default)
import Skalex from "skalex";
const db = new Skalex({ path: "./.db" });

// Browser
import { LocalStorageAdapter } from "skalex/adapters";
const db = new Skalex({ adapter: new LocalStorageAdapter({ namespace: "myapp" }) });

// Custom / in-memory
const db = new Skalex({ adapter: myCustomAdapter });
```

### Custom Adapter Interface

```javascript
class MyAdapter {
  async read(name)        { /* return JSON string or null */ }
  async write(name, data) { /* data is a JSON string */ }
  async delete(name)      { /* remove the collection */ }
  async list()            { /* return string[] of collection names */ }
}
```

---

## Embedding Adapters

Enable vector search by passing an `ai` config to the constructor. Skalex ships two built-in adapters.

### OpenAI

```javascript
const db = new Skalex({
  path: "./data",
  ai: {
    provider: "openai",
    apiKey: process.env.OPENAI_KEY,
    embedModel: "text-embedding-3-small", // default — 1536 dimensions
  },
});
```

### Ollama (local, zero cost)

```javascript
const db = new Skalex({
  path: "./data",
  ai: {
    provider: "ollama",
    embedModel: "nomic-embed-text",       // default — 768 dimensions
    host: "http://localhost:11434",       // default
  },
});
```

Run locally: `ollama pull nomic-embed-text`

### Custom Adapter

```javascript
import { EmbeddingAdapter } from "skalex";

class MyEmbeddingAdapter extends EmbeddingAdapter {
  async embed(text) {
    // call your embedding API
    return [0.1, 0.2, ...]; // number[]
  }
}

// Inject directly
const db = new Skalex({ path: "./data" });
db._embeddingAdapter = new MyEmbeddingAdapter();
```

---

## Language Model Adapters

Enable `db.ask()` and `memory.compress()` by providing a `model` in the `ai` config. The same `ai` object controls both embedding and language model — use `embedModel` to pin the embedding model separately.

### OpenAI

```javascript
const db = new Skalex({
  ai: {
    provider: "openai",
    apiKey: process.env.OPENAI_KEY,
    embedModel: "text-embedding-3-small", // default
    model: "gpt-4o-mini",                 // default LLM
  },
});
```

### Anthropic

```javascript
const db = new Skalex({
  ai: {
    provider: "anthropic",
    apiKey: process.env.ANTHROPIC_KEY,
    model: "claude-haiku-4-5",            // default
  },
});
```

### Ollama (local, zero cost)

```javascript
const db = new Skalex({
  ai: {
    provider: "ollama",
    embedModel: "nomic-embed-text",
    model: "llama3.2",                    // default
    host: "http://localhost:11434",
  },
});
```

Run locally: `ollama pull llama3.2`

---

## Class: Memory

Episodic agent memory backed by a `_memory_<sessionId>` collection. Obtain via `db.useMemory(sessionId)`.

### `remember(text)`

Stores a text entry with a semantic embedding.

**Returns:** `Promise<{ data: Document }>`

### `recall(query, options?)`

Retrieves the most semantically relevant memories.

| Option | Type | Default |
|--------|------|---------|
| `limit` | `number` | `10` |
| `minScore` | `number` | `0` |

**Returns:** `Promise<{ docs: Document[], scores: number[] }>`

### `history(options?)`

Returns all memories in chronological order.

| Option | Type | Description |
|--------|------|-------------|
| `since` | `string \| Date` | Only entries after this time |
| `limit` | `number` | Maximum entries |

**Returns:** `Promise<Document[]>`

### `forget(id)`

Deletes a memory entry by `_id`.

**Returns:** `Promise<{ data: Document } | null>`

### `tokenCount()`

Returns a rough token estimate of all stored memories (chars ÷ 4 heuristic).

**Returns:** `{ tokens: number, count: number }`

### `context(options?)`

Returns a newline-joined string of the most recent memories within a token budget, suitable for LLM context injection.

| Option | Type | Default |
|--------|------|---------|
| `tokens` | `number` | `2000` |

**Returns:** `string`

### `compress(options?)`

Summarises old memories using the language model adapter and replaces them with a single compressed entry. The 10 most recent entries are always kept intact.

| Option | Type | Default |
|--------|------|---------|
| `threshold` | `number` | `10` |

**Returns:** `Promise<void>`

---

## Class: ChangeLog

Append-only mutation log. Enabled per-collection with `createCollection(name, { changelog: true })`. Obtain via `db.changelog()`.

### `log(op, collection, doc, prev?, session?)`

Records a mutation. Called automatically by collection methods when changelog is enabled.

### `query(collection, options?)`

Returns log entries for a collection.

| Option | Type | Description |
|--------|------|-------------|
| `since` | `string \| Date` | Only entries after this time |
| `limit` | `number` | Maximum entries |
| `session` | `string` | Filter by session ID |

**Returns:** `Promise<ChangeLogEntry[]>`

Each entry: `{ _id, op, collection, docId, doc, prev?, timestamp, session? }`

### `restore(collection, timestamp, options?)`

Replays log entries to rebuild the collection's state at the given point in time. With `{ _id }`, restores only a single document.

**Returns:** `Promise<void>`

```javascript
db.createCollection("orders", { changelog: true });
await db.connect();

const orders = db.useCollection("orders");
const ts = new Date();

await orders.insertOne({ item: "Widget", qty: 5 });
await orders.updateOne({ item: "Widget" }, { qty: 10 });

// Roll back to state before the update
await db.restore("orders", ts);
```

---

## Class: SkalexMCPServer

Exposes the Skalex database as MCP tools for AI agents (Claude Desktop, Cursor, and any MCP-compatible client). Obtain via `db.mcp(options)`.

### Methods

#### `listen()`

Starts the configured transport (stdio or HTTP + SSE).

**Returns:** `Promise<void>`

#### `connect(transport)`

Accepts a custom transport object — useful for testing or embedding.

**Returns:** `Promise<void>`

#### `close()`

Stops the server and releases all resources.

**Returns:** `Promise<void>`

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `transport` | `"stdio" \| "http"` | The configured transport type |
| `url` | `string \| undefined` | HTTP base URL (http transport only) |

### Available MCP Tools

| Tool | Scope | Description |
|------|-------|-------------|
| `skalex_collections` | read | List all collection names |
| `skalex_schema` | read | Get schema for a collection |
| `skalex_find` | read | Query documents |
| `skalex_insert` | write | Insert a document |
| `skalex_update` | write | Update the first matching document |
| `skalex_delete` | write | Delete the first matching document |
| `skalex_search` | read | Semantic vector search |
| `skalex_ask` | read | Natural language query |

### Access Control

The `scopes` map grants per-collection permissions. `"*"` is the wildcard fallback. A collection-specific entry overrides the wildcard.

```javascript
const server = db.mcp({
  scopes: {
    "public":    ["read"],
    "orders":    ["read", "write"],
    "admin_log": ["admin"],
    "*":         ["read"],
  },
});
```

Read-only scopes hide write tools from `tools/list`, preventing AI agents from discovering or calling them.

### Claude Desktop / Cursor integration

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "skalex": {
      "command": "node",
      "args": ["./mcp-server.js"]
    }
  }
}
```

```javascript
// mcp-server.js
import Skalex from "skalex";

const db = new Skalex({ path: "./data" });
await db.connect();

const server = db.mcp(); // stdio by default
await server.listen();
```

---

## Encryption

At-rest encryption using AES-256-GCM via `globalThis.crypto.subtle`. Works in Node ≥ 18, Bun, Deno, and all modern browsers — zero extra dependencies.

```javascript
const db = new Skalex({
  path: "./data",
  encrypt: {
    key: process.env.DB_KEY, // 64-char hex string or 32-byte Uint8Array
  },
});
```

All reads and writes are transparently encrypted/decrypted. The wire format is `base64(iv[12] | ciphertext + authTag[16])` with a random IV per write.

`namespace()` instances inherit the parent's encryption key automatically.

---

## Slow Query Log

```javascript
const db = new Skalex({
  path: "./data",
  slowQueryLog: {
    threshold:  50,   // ms — queries longer than this are recorded (default: 100)
    maxEntries: 1000, // ring buffer size (default: 500)
  },
});
await db.connect();

// ... run some queries ...

const slow = db.slowQueries({ minDuration: 100, limit: 10 });
for (const entry of slow) {
  console.log(`${entry.collection}.${entry.op} took ${entry.duration}ms`);
}
```

Instrumented on `find()` and `search()`.

---

## TTL Documents

```javascript
// Expires in 30 minutes
await sessions.insertOne({ userId: "abc", token: "xyz" }, { ttl: "30m" });

// Expires in 7 days
await cache.insertOne({ key: "trending", value: [...] }, { ttl: "7d" });

// Expires in 300 seconds
await locks.insertOne({ resource: "job-1" }, { ttl: 300 });
```

Expired documents are swept automatically every time `db.connect()` is called.

---

## Document Shape

Every document inserted by Skalex has the following system fields added automatically:

| Field | Type | Description |
|-------|------|-------------|
| `_id` | `string` | 24-character hex ID (timestamp + crypto random) |
| `createdAt` | `Date` | Set once at insert time |
| `updatedAt` | `Date` | Set at insert time, updated on every write |
| `_expiresAt` | `Date` | Set when `ttl` option is provided |
