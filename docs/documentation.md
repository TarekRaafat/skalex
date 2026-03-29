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
| `ai` | `object` | `undefined` | AI / embedding config — see [Embedding Adapters](#embedding-adapters) |

```javascript
const db = new Skalex({ path: "./data", format: "json" });
```

```javascript
// With AI (enables vector search)
const db = new Skalex({
  path: "./data",
  ai: {
    provider: "openai",
    apiKey: process.env.OPENAI_KEY,
    // model: "text-embedding-3-small" (default)
  },
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

**Returns:** `Promise<{ data: Document }>`

```javascript
const { data } = await users.insertOne({ name: "Alice" }, { ttl: "24h" });
```

#### `insertMany(documents, options?)`

| Option | Type | Description |
|--------|------|-------------|
| `save` | `boolean` | Immediately persist after insert |
| `ttl` | `number \| string` | Set expiry on all inserted documents |
| `embed` | `string \| Function` | Field name (or selector fn) whose value is embedded and stored as `_vector` |

**Returns:** `Promise<{ docs: Document[] }>`

---

### Update

#### `updateOne(filter, update, options?)`

Updates the first matching document. Supports `$inc` and `$push` operators.

**Returns:** `Promise<{ data: Document } | null>`

```javascript
await users.updateOne({ name: "Alice" }, { score: { $inc: 10 } });
await users.updateOne({ name: "Alice" }, { tags:  { $push: "vip" } });
```

#### `updateMany(filter, update, options?)`

Updates all matching documents.

**Returns:** `Promise<{ docs: Document[] }>`

#### `upsert(filter, doc, options?)`

Updates the first match, or inserts `{ ...filter, ...doc }` if no match is found.

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

**Returns:** `Promise<{ data: Document } | null>`

#### `deleteMany(filter, options?)`

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
    model: "text-embedding-3-small", // default — 1536 dimensions
  },
});
```

### Ollama (local, zero cost)

```javascript
const db = new Skalex({
  path: "./data",
  ai: {
    provider: "ollama",
    model: "nomic-embed-text",        // default — 768 dimensions
    host: "http://localhost:11434",   // default
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
