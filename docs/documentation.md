# Documentation <!-- {docsify-ignore} -->

---

## Class: Skalex

The root database class. Create one instance per process  -  that's all the setup Skalex needs. Everything else: collections, persistence, migrations, transactions, AI queries, and the MCP server, flows from here.

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
| `ai` | `object` |  -  | AI / embedding config; see [Embedding Adapters](#embedding-adapters) and [Language Model Adapters](#language-model-adapters) |
| `encrypt` | `object` | `undefined` | At-rest encryption; see [Encryption](#encryption) |
| `slowQueryLog` | `object` | `undefined` | Slow query recording; see [Slow Query Log](#slow-query-log) |
| `queryCache` | `object` | `undefined` | Query cache options: `{ maxSize?: number, ttl?: number }` |
| `memory` | `object` | `undefined` | Global memory options: `{ compressionThreshold?, maxEntries?, keepRecent?, contextTokens? }` |
| `logger` | `Function` | built-in | Custom logger `(message, level) => void`. Replaces the built-in `console.log/error`. |
| `llmAdapter` | `LLMAdapter` |  -  | Pre-built LLM adapter instance. Overrides the `ai` factory for language model calls. |
| `embeddingAdapter` | `EmbeddingAdapter` |  -  | Pre-built embedding adapter instance. Overrides the `ai` factory for embedding calls. |
| `regexMaxLength` | `number` | `500` | Maximum `$regex` pattern length in `ask()` filters. |
| `idGenerator` | `Function` | built-in | Custom document ID generator `() => string`. Default: built-in timestamp+random. |
| `serializer` | `Function` | `JSON.stringify` | Custom serializer for storage writes `(data) => string`. |
| `deserializer` | `Function` | `JSON.parse` | Custom deserializer for storage reads `(raw) => object`. |
| `plugins` | `Plugin[]` |  -  | Pre-register plugins; see [Plugin System](#plugin-system) |
| `autoSave` | `boolean` | `false` | Automatically persist after every write without passing `{ save: true }`. Individual calls can opt out with `{ save: false }`. |
| `ttlSweepInterval` | `number` |  -  | Interval in ms to periodically sweep expired TTL documents. Cleared on `disconnect()`. See [TTL Documents](#ttl-documents). |

**`ai` config fields:**

| Field | Default | Env var | Description |
|-------|---------|---------|-------------|
| `provider` |  -  |  -  | `"openai"`, `"anthropic"`, or `"ollama"` (required) |
| `apiKey` |  -  | `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | API key (required for OpenAI and Anthropic) |
| `model` | `"gpt-4o-mini"` / `"claude-haiku-4-5"` / `"llama3.2"` | `OPENAI_MODEL` / `ANTHROPIC_MODEL` / `OLLAMA_MODEL` | Language model for `db.ask()` and `memory.compress()` |
| `embedModel` | `"text-embedding-3-small"` / `"nomic-embed-text"` | `OPENAI_EMBED_MODEL` / `OLLAMA_EMBED_MODEL` | Embedding model for vector search |
| `host` | `"http://localhost:11434"` | `OLLAMA_HOST` | Ollama server URL |
| `baseUrl` | `"https://api.openai.com/v1/chat/completions"` / `"https://api.anthropic.com/v1/messages"` | `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` | LLM endpoint override (proxies, OpenAI-compatible APIs) |
| `embedBaseUrl` | `"https://api.openai.com/v1/embeddings"` | `OPENAI_EMBED_BASE_URL` | Embedding endpoint override (OpenAI only) |
| `apiVersion` | `"2023-06-01"` |  -  | Anthropic-Version header (Anthropic only) |
| `temperature` | `0.3` | `OPENAI_TEMPERATURE` / `ANTHROPIC_TEMPERATURE` / `OLLAMA_TEMPERATURE` | Sampling temperature for `summarize()`. `generate()` always uses `0`. |
| `maxTokens` | `1024` | `OPENAI_MAX_TOKENS` / `ANTHROPIC_MAX_TOKENS` | Maximum tokens for LLM responses |
| `topP` |  -  | `OPENAI_TOP_P` / `ANTHROPIC_TOP_P` / `OLLAMA_TOP_P` | Nucleus sampling for `summarize()`. (OpenAI, Anthropic, Ollama) |
| `topK` |  -  | `ANTHROPIC_TOP_K` / `OLLAMA_TOP_K` | Top-K sampling for `summarize()`. (Anthropic, Ollama only) |
| `organization` |  -  | `OPENAI_ORGANIZATION` | OpenAI organization ID for billing. (OpenAI only) |
| `timeout` |  -  | `OPENAI_TIMEOUT` / `ANTHROPIC_TIMEOUT` / `OLLAMA_TIMEOUT` | LLM request timeout in ms |
| `dimensions` |  -  | `OPENAI_EMBED_DIMENSIONS` | Embedding output dimensions (`text-embedding-3-*` only). (OpenAI only) |
| `embedTimeout` |  -  | `OPENAI_EMBED_TIMEOUT` / `OLLAMA_EMBED_TIMEOUT` | Embedding request timeout in ms |
| `retries` | `0` | `OPENAI_RETRIES` / `ANTHROPIC_RETRIES` / `OLLAMA_RETRIES` | LLM retry attempts on failure (exponential backoff) |
| `retryDelay` | `1000` | `OPENAI_RETRY_DELAY` / `ANTHROPIC_RETRY_DELAY` / `OLLAMA_RETRY_DELAY` | LLM base retry delay in ms (doubles each attempt) |
| `embedRetries` | `0` | `OPENAI_EMBED_RETRIES` / `OLLAMA_EMBED_RETRIES` | Embedding retry attempts on failure |
| `embedRetryDelay` | `1000` | `OPENAI_EMBED_RETRY_DELAY` / `OLLAMA_EMBED_RETRY_DELAY` | Embedding base retry delay in ms |
| `seed` |  -  | `OPENAI_SEED` | Seed for deterministic outputs (OpenAI only) |
| `generatePrompt` | built-in |  -  | Custom system prompt for `generate()`. Schema is always appended automatically. |
| `summarizePrompt` | built-in |  -  | Custom system prompt for `summarize()`. |

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
    embedModel: "text-embedding-3-small", // default  -  for insertOne/search
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

```javascript
// With pre-registered plugins
const db = new Skalex({
  path: "./data",
  plugins: [myAuditPlugin],
});
```

---

### Connection

#### `connect()`

Loads persisted data, runs pending migrations, sweeps expired TTL documents. If `ttlSweepInterval` was configured, starts the periodic sweep timer.

**Returns:** `Promise<void>`

#### `disconnect()`

Flushes all unsaved data to the storage adapter, clears in-memory state. Stops the TTL sweep timer if one is running.

**Returns:** `Promise<void>`

---

### Collections

#### `useCollection(name)`

Returns a cached `Collection` instance. Creates the collection if it does not exist.

**Returns:** `Collection`

#### `createCollection(name, options?)`

Defines a collection with optional schema and secondary indexes. Call before `connect()` to ensure schema is applied when loading persisted data. Schema and changelog settings are persisted to the storage adapter and survive disconnect/reconnect cycles without requiring a repeat call to `createCollection()`.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `schema` | `object` |  -  | Schema definition; see [Schema Validation](#schema-validation) |
| `indexes` | `string[]` | `[]` | Fields to build secondary (non-unique) indexes on |
| `changelog` | `boolean` | `false` | Enable append-only mutation log for this collection |
| `softDelete` | `boolean` | `false` | Mark documents with `_deletedAt` instead of removing them. Use `col.restore()` to undo. |
| `versioning` | `boolean` | `false` | Auto-increment `_version` on every insert (starts at `1`) and update |
| `strict` | `boolean` | `false` | Reject documents containing fields not declared in the schema |
| `onSchemaError` | `"throw" \| "warn" \| "strip"` | `"throw"` | Behaviour on validation failure: throw (default), log a warning and proceed, or strip invalid fields |
| `defaultTtl` | `number \| string` |  -  | Default TTL applied to every inserted document (seconds or shorthand like `"24h"`) |
| `defaultEmbed` | `string` |  -  | Field name whose value is auto-embedded as `_vector` on every insert |
| `maxDocs` | `number` |  -  | Maximum document count (capped collection). Oldest documents are evicted FIFO when exceeded. |

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

```javascript
// Capped collection  -  keeps the latest 1000 log lines
const logs = db.createCollection("logs", { maxDocs: 1000 });

// Soft-delete  -  documents are hidden but not removed
const posts = db.createCollection("posts", { softDelete: true });

// Versioned  -  every update increments _version
const orders = db.createCollection("orders", { versioning: true });

// Strict + strip  -  unknown fields silently removed before insert
const events = db.createCollection("events", {
  schema: { type: "string", payload: "object" },
  strict: true,
  onSchemaError: "strip",
});

// Default TTL  -  all sessions auto-expire in 24 hours
const sessions = db.createCollection("sessions", { defaultTtl: "24h" });

// Default embed  -  every article auto-embedded on insert
const articles = db.createCollection("articles", { defaultEmbed: "body" });
```

---

### Persistence

Skalex keeps all data **in memory** between operations. Writes are flushed to the storage adapter automatically after every mutating operation (`insertOne`, `insertMany`, `updateOne`, `updateMany`, `deleteOne`, `deleteMany`). You can suppress this with `{ save: false }` on individual calls and flush manually.

> **Important:** If the process is killed before a flush completes (e.g. `kill -9`, power loss), the in-flight write may be lost. For Node.js, the `FsAdapter` uses an atomic temp-file-then-rename strategy to prevent corrupt files; a collection is either fully written or left at its last good state. Always call `await db.disconnect()` for a clean shutdown.

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

Runs `fn` inside a transaction. On success, all changes are flushed to storage. On error, all in-memory state is rolled back to the pre-transaction snapshot  -  including deletion of any collections that were created inside `fn`.

**Returns:** `Promise<any>`, the return value of `fn`

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

Returns a plain-object snapshot of all user collection data. Internal system collections (prefixed `_`) are excluded.

**Returns:** `Record<string, Document[]>`

#### `inspect(collectionName?)`

Returns metadata about one or all collections.

**Returns:** `{ name, count, schema, indexes, softDelete, versioning, strict, onSchemaError, maxDocs }` or a map of all collections.

#### `namespace(id)`

Returns a new `Skalex` instance scoped to a sub-directory (`<dataPath>/<id>`) of the current data path. Useful for multi-tenant isolation where each tenant has a completely separate store.

**ID sanitization:** Characters outside `[a-zA-Z0-9_-]` are replaced with `_`.

**Inherited config:** The namespace inherits `format`, `debug`, `ai`, `encrypt`, `slowQueryLog`, `plugins`, `memory`, `logger`, `llmAdapter`, `embeddingAdapter`, `regexMaxLength`, `idGenerator`, `serializer`, `deserializer`, `autoSave`, and `ttlSweepInterval` from the parent instance.

**Independence:** Each namespace is a fully independent `Skalex` instance. It requires its own `connect()` / `disconnect()` calls and does not share in-memory state with the parent.

**Requires default storage:** `namespace()` uses the built-in `FsAdapter` to create a sub-directory store. It throws if a custom `adapter` was passed to the constructor  -  in that case, construct a separate `Skalex` instance with your adapter directly.

**Returns:** `Skalex`

```javascript
const tenant = db.namespace("tenant-001");
await tenant.connect();
await tenant.useCollection("orders").insertOne({ item: "Widget" });
await tenant.disconnect();
```

#### `embed(text)`

Embeds a text string using the configured AI adapter.

**Returns:** `Promise<number[]>`

Throws if no `ai` config was provided to the constructor.

```javascript
const vector = await db.embed("zero-dependency JS database");
```

#### `import(filePath)`

Imports documents from a JSON file. The collection name is derived from the file name (without extension). Requires an adapter that supports `readRaw` (e.g. `FsAdapter`).

**Returns:** `Promise<Document[]>`

---

### AI Query

#### `ask(collectionName, nlQuery, options?)`

Translates a natural language query into a structured filter via the configured language model, then runs `find()` on the target collection. Results are cached by a hash of `{ collection, schema, query }` and persisted across connect/disconnect cycles.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `limit` | `number` | `20` | Maximum results |

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

#### `slowQueryCount()`

Returns the number of entries currently in the slow query buffer.

**Returns:** `number`

#### `clearSlowQueries()`

Clears all recorded slow query entries from the buffer.

#### `sessionStats(sessionId?)`

Returns `{ sessionId, reads, writes, lastActive }` for the given session ID, or an array of all sessions when called without arguments. See [Session Stats](#session-stats).

#### `use(plugin)`

Registers a plugin object that intercepts database operations via pre/post hooks. See [Plugin System](#plugin-system).

---

### Global Watch

#### `watch(callback)`

Subscribes to all mutation events across every collection. Fires after every `insertOne`, `insertMany`, `updateOne`, `updateMany`, `deleteOne`, `deleteMany`, and `restore`.

**Returns:** `() => void`  -  unsubscribe function

Event shape: `{ op: "insert"|"update"|"delete"|"restore", collection, doc, prev? }`

```javascript
const unsub = db.watch((event) => {
  console.log(`[${event.collection}] ${event.op}`, event.doc._id);
});

unsub(); // stop watching
```

---

### Collection Rename

#### `renameCollection(from, to)`

Renames a collection in memory, persists it under the new name, and removes the old file via the storage adapter. Throws if `from` does not exist or `to` already exists.

**Returns:** `Promise<void>`

```javascript
await db.renameCollection("legacy_users", "users");
```

---

### MCP Server

#### `mcp(options?)`

Creates and returns a `SkalexMCPServer` that exposes the database as MCP tools for AI agents.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `transport` | `"stdio" \| "http"` | `"stdio"` | Transport type |
| `port` | `number` | `3000` | HTTP port (http transport only) |
| `host` | `string` | `"127.0.0.1"` | HTTP host (http transport only) |
| `scopes` | `object` | `{ "*": ["read"] }` | Access control per collection; read-only by default |
| `allowedOrigin` | `string \| null` | `null` | CORS origin for HTTP transport; disabled by default |
| `maxBodySize` | `number` | `1048576` | Maximum POST body size in bytes for HTTP transport (default 1 MiB); increase when inserting documents with large text fields via MCP |

**Returns:** `SkalexMCPServer`

See [Class: SkalexMCPServer](#class-skalexmcpserver) for details.

```javascript
// Claude Desktop / Cursor  -  stdio transport
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

The unit of storage in Skalex. Every document lives in a collection. Collections are created on demand and cached  -  call `db.useCollection()` anywhere and you always get the same instance. Define schemas and indexes upfront with `db.createCollection()` for validation and O(1) queries.

---

### Insert

#### `insertOne(document, options?)`

| Option | Type | Description |
|--------|------|-------------|
| `save` | `boolean` | Immediately persist after insert |
| `ifNotExists` | `boolean` | Return the existing doc if a match is found; no duplicate inserted |
| `ttl` | `number \| string` | Set expiry: number = seconds, or `"30m"`, `"24h"`, `"7d"` |
| `embed` | `string \| Function` | Field name (or selector fn) whose value is embedded and stored as `_vector` |
| `session` | `string` | Session ID for audit trail (passed to changelog) |

**Returns:** `Promise<Document>`

```javascript
const doc = await users.insertOne({ name: "Alice" }, { ttl: "24h" });
const doc = await users.insertOne({ name: "Bob" }, { session: "user-123" });
```

#### `insertMany(documents, options?)`

| Option | Type | Description |
|--------|------|-------------|
| `save` | `boolean` | Immediately persist after insert |
| `ttl` | `number \| string` | Set expiry on all inserted documents |
| `embed` | `string \| Function` | Field name (or selector fn) whose value is embedded and stored as `_vector` |
| `session` | `string` | Session ID for audit trail |

**Returns:** `Promise<Document[]>`

---

### Update

#### `updateOne(filter, update, options?)`

Updates the first matching document. Supports `$inc` and `$push` operators.

| Option | Type | Description |
|--------|------|-------------|
| `save` | `boolean` | Immediately persist after update |
| `session` | `string` | Session ID for audit trail |

**Returns:** `Promise<Document | null>`

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

**Returns:** `Promise<Document[]>`

### Update Operators

All update methods accept plain field assignments and the following operators:

| Operator | Type | Description |
|----------|------|-------------|
| `$inc` | `number` | Increment a numeric field by the given value (use a negative value to decrement) |
| `$push` | `any` | Append a value to an array field; creates the array if the field does not exist |

```javascript
// $inc  -  increment/decrement
await users.updateOne({ name: "Alice" }, { score: { $inc: 10 } });
await accounts.updateOne({ name: "Bob" }, { balance: { $inc: -50 } });

// $push  -  append to array
await users.updateOne({ name: "Alice" }, { tags: { $push: "vip" } });
```

#### `upsert(filter, doc, options?)`

Updates the first match, or inserts `{ ...filter, ...doc }` if no match is found.

| Option | Type | Description |
|--------|------|-------------|
| `save` | `boolean` | Immediately persist after operation |
| `session` | `string` | Session ID for audit trail |

**Returns:** `Promise<Document>`

#### `upsertMany(docs, matchKey, options?)`

Batch upsert. For each doc in `docs`, matches on `matchKey` and updates if found, inserts otherwise. Issues a single save at the end (honouring `autoSave`).

| Option | Type | Description |
|--------|------|-------------|
| `save` | `boolean` | Immediately persist after all upserts |
| `ttl` | `number \| string` | Set expiry on inserted documents |
| `embed` | `string \| Function` | Field name (or selector fn) to embed on inserted documents |
| `session` | `string` | Session ID for audit trail |

**Returns:** `Promise<Document[]>`

```javascript
await products.upsertMany(
  [{ sku: "A1", price: 9.99 }, { sku: "B2", price: 4.99 }],
  "sku",
  { save: true }
);
```

---

### Find

#### `findOne(filter, options?)`

| Option | Type | Description |
|--------|------|-------------|
| `populate` | `string[]` | Collection names to join on the matching field |
| `select` | `string[]` | Fields to include in the returned document |
| `includeDeleted` | `boolean` | Include soft-deleted documents (requires `softDelete: true`). Default: `false`. |

**Returns:** `Promise<Document | null>`

#### `find(filter, options?)`

| Option | Type | Description |
|--------|------|-------------|
| `populate` | `string[]` | Collection names to join |
| `select` | `string[]` | Fields to include |
| `sort` | `object` | `{ field: 1 }` ascending, `{ field: -1 }` descending |
| `page` | `number` | Page number (requires `limit`) |
| `limit` | `number` | Documents per page |
| `session` | `string` | Tag this read for session stats tracking |
| `includeDeleted` | `boolean` | Include soft-deleted documents (requires `softDelete: true`). Default: `false`. |

**Returns:** `Promise<{ docs, page?, totalDocs?, totalPages? }>`

---

### Populate

`populate` joins related documents at query time. The convention Skalex uses is:

- The **field name in the document must exactly match the target collection name**.
- Skalex looks up `{ _id: doc[field] }` in the collection named `field` and replaces the field value with the found document.
- If no matching document is found, the field keeps its original value unchanged.

```javascript
const users = db.useCollection("users");
const posts = db.useCollection("posts");

// Store a user ID under a field named "users"  -  matching the collection name
const user = await users.insertOne({ name: "Alice" });
await posts.insertOne({ title: "Hello World", users: user._id });

// Populate replaces the "users" ID with the full user document
const { docs } = await posts.find(
  { users: user._id },
  { populate: ["users"] }
);

console.log(docs[0].users.name); // "Alice"
// If the user had been deleted, docs[0].users would still be the original _id string
```

Multiple fields can be populated in a single query: `{ populate: ["users", "categories"] }`.

---

### Delete

#### `deleteOne(filter, options?)`

When `softDelete: true` is set on the collection, sets `_deletedAt` instead of removing the document. Hard-deletes otherwise.

| Option | Type | Description |
|--------|------|-------------|
| `save` | `boolean` | Immediately persist after delete |
| `session` | `string` | Session ID for audit trail |

**Returns:** `Promise<Document | null>`

#### `deleteMany(filter, options?)`

When `softDelete: true` is set on the collection, sets `_deletedAt` on all matched documents. Hard-deletes otherwise.

| Option | Type | Description |
|--------|------|-------------|
| `save` | `boolean` | Immediately persist after delete |
| `session` | `string` | Session ID for audit trail |

**Returns:** `Promise<Document[]>`

#### `restore(filter, options?)`

Undoes a soft delete by clearing `_deletedAt`. Requires `softDelete: true` on the collection.

| Option | Type | Description |
|--------|------|-------------|
| `save` | `boolean` | Immediately persist after restore |
| `session` | `string` | Session ID for audit trail |

**Returns:** `Promise<Document | null>`  -  the restored document, or `null` if not found or not deleted.

```javascript
const posts = db.createCollection("posts", { softDelete: true });

// Soft-delete
await posts.deleteOne({ _id: "abc" });

// Restore
await posts.restore({ _id: "abc" }, { save: true });

// Access soft-deleted docs
const { docs } = await posts.find({}, { includeDeleted: true });
```

---

### Export

#### `export(filter?, options?)`

Exports matched documents to JSON or CSV via the storage adapter.

| Option | Type | Description |
|--------|------|-------------|
| `dir` | `string` | Export directory (default: `<dataDirectory>/exports`) |
| `name` | `string` | Output file name (default: collection name) |
| `format` | `"json" \| "csv"` | Output format (default: `"json"`) |

**Throws:** `Error` if no documents match the filter, or if the current storage adapter does not implement `writeRaw` (i.e. non-FsAdapter backends such as D1, BunSQLite, LibSQL, and LocalStorage do not support export).

---

### Vector Search

#### `search(query, options?)`

Embeds `query` using the configured AI adapter and ranks all documents that have a `_vector` field by cosine similarity. The `_vector` field is never returned in results.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `filter` | `object` | `undefined` | Structured pre-filter applied before scoring (hybrid search) |
| `limit` | `number` | `10` | Maximum number of results |
| `minScore` | `number` | `0` | Minimum cosine similarity score; range [-1, 1] |
| `session` | `string` | | Tag this read for session stats tracking |

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

Observe mutations on a collection. Fires after every `insertOne`, `insertMany`, `updateOne`, `updateMany`, `deleteOne`, `deleteMany`, and `restore`.

Event shape: `{ op: "insert"|"update"|"delete"|"restore", collection, doc, prev? }`

**Callback form**: returns an unsubscribe function:

```javascript
const unsub = users.watch((event) => {
  console.log(event.op, event.doc.name);
});

// With a filter  -  only fires when doc matches
const unsub = users.watch({ role: "admin" }, (event) => {
  console.log("Admin changed:", event.doc);
});

unsub(); // stop watching
```

**AsyncIterableIterator form**: no callback:

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
await users.find({ email: { $regex: "^alice" } });  // string pattern also accepted

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
| `$regex` | Matches `RegExp` or regex string pattern |
| `$fn` | Passes custom function |

---

## Schema Validation

Define schemas on `createCollection()`. Validation runs at insert time.

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

### Error handling

By default, any validation failure throws. Use `onSchemaError` to change behaviour:

| Value | Behaviour |
|-------|-----------|
| `"throw"` | Throws `Error`. Default. |
| `"warn"` | Logs a warning via the configured logger and proceeds with the original document. |
| `"strip"` | Strips unknown fields and fields with type/enum violations; inserts the cleaned document. |

```javascript
db.createCollection("events", {
  schema: { type: "string", payload: "object" },
  onSchemaError: "strip", // silently clean instead of throwing
});
```

### Strict mode

Enabling `strict: true` treats **unknown fields** (fields not declared in the schema) as validation errors. Combined with `onSchemaError: "strip"`, this produces a tight, self-cleaning collection.

```javascript
db.createCollection("users", {
  schema: { name: "string", email: "string" },
  strict: true, // reject documents with undeclared fields
});
```

---

## Storage Adapters

One codebase, every runtime. All I/O routes through a `StorageAdapter` interface  -  swap the backend without changing a single line of application code. Node.js to browser to edge: same API, different adapter.

Import via the connectors subpackage (npm + bundler):

```javascript
// All storage adapters  -  fully tree-shakeable
import { FsAdapter, LocalStorageAdapter, EncryptedAdapter,
         BunSQLiteAdapter, D1Adapter, LibSQLAdapter } from 'skalex/connectors/storage';

// Or from the root barrel (all connector types)
import { FsAdapter, LocalStorageAdapter, EncryptedAdapter } from 'skalex/connectors';
```

```javascript
// Node.js (default)
import Skalex from "skalex";
const db = new Skalex({ path: "./.db" });

// Browser
import { LocalStorageAdapter } from "skalex/connectors/storage";
const db = new Skalex({ adapter: new LocalStorageAdapter({ namespace: "myapp" }) });

// Custom / in-memory
const db = new Skalex({ adapter: myCustomAdapter });
```

> **Browser storage limit:** `localStorage` is capped at **~5 MB per origin** by all major browsers. Once this limit is reached, writes will throw a `QuotaExceededError`. For larger datasets in the browser, use IndexedDB via a custom adapter or move storage server-side.

### Bun SQLite

Uses Bun's built-in `bun:sqlite`  -  zero extra dependencies. Pass `":memory:"` for an ephemeral in-memory database.

```javascript
import BunSQLiteAdapter from "skalex/connectors/bun-sqlite";

const db = new Skalex({
  adapter: new BunSQLiteAdapter("./data.db"), // or ":memory:" for ephemeral
});
await db.connect();
```

The second argument accepts an options object:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `table` | `string` | `"skalex_store"` | SQLite table name. Falls back to `SKALEX_TABLE` env var. |

```javascript
new BunSQLiteAdapter("./data.db", { table: "my_store" })
```

Requires the Bun runtime.

### Cloudflare D1

Pass the D1Database binding from your Worker's `env` object. Works on Cloudflare Workers and Pages Functions.

```javascript
import D1Adapter from "skalex/connectors/d1";

export default {
  async fetch(request, env) {
    const db = new Skalex({ adapter: new D1Adapter(env.DB) });
    await db.connect();
    // ... handle request
  }
};
```

The second argument accepts an options object:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `table` | `string` | `"skalex_store"` | D1 table name. Falls back to `SKALEX_TABLE` env var. |

```javascript
new D1Adapter(env.DB, { table: "my_store" })
```

### LibSQL / Turso

Compatible with any `@libsql/client`-compatible client  -  local file, Turso cloud, or embedded replica.

```javascript
import LibSQLAdapter from "skalex/connectors/libsql";
import { createClient } from "@libsql/client";

const client = createClient({
  url: process.env.TURSO_URL,
  authToken: process.env.TURSO_TOKEN,
});

const db = new Skalex({ adapter: new LibSQLAdapter(client) });
await db.connect();
```

The second argument accepts an options object:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `table` | `string` | `"skalex_store"` | LibSQL table name. Falls back to `SKALEX_TABLE` env var. |

```javascript
new LibSQLAdapter(client, { table: "my_store" })
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

Import via the connectors subpackage (npm + bundler):

```javascript
import { OpenAIEmbeddingAdapter, OllamaEmbeddingAdapter } from 'skalex/connectors/embedding';
// Or from the root barrel
import { OpenAIEmbeddingAdapter, OllamaEmbeddingAdapter } from 'skalex/connectors';
```

> **Cost & availability:** The OpenAI and Anthropic adapters make outbound API calls that **incur charges** on your account and are subject to **rate limits**. Every `insertOne`/`insertMany` with `{ embed }` and every `search()` call triggers an embedding request. For zero-cost local embeddings, use the Ollama adapter. If the API provider is unavailable, the operation will throw; add appropriate error handling or retry logic in production.

### OpenAI

```javascript
const db = new Skalex({
  path: "./data",
  ai: {
    provider: "openai",
    apiKey: process.env.OPENAI_KEY,       // or set OPENAI_API_KEY env var
    embedModel: "text-embedding-3-small", // default  -  1536 dimensions; or set OPENAI_EMBED_MODEL env var
  },
});
```

To use a proxy or an OpenAI-compatible API, pass `embedBaseUrl`:

```javascript
ai: {
  provider: "openai",
  apiKey: process.env.OPENAI_KEY,
  embedBaseUrl: "https://my-proxy.com/v1/embeddings", // or set OPENAI_EMBED_BASE_URL env var
}
```

| `ai` field | Env var | Default |
|------------|---------|---------|
| `apiKey` | `OPENAI_API_KEY` |  -  |
| `embedModel` | `OPENAI_EMBED_MODEL` | `"text-embedding-3-small"` |
| `embedBaseUrl` | `OPENAI_EMBED_BASE_URL` | `"https://api.openai.com/v1/embeddings"` |
| `dimensions` | `OPENAI_EMBED_DIMENSIONS` |  -  |
| `organization` | `OPENAI_ORGANIZATION` |  -  |
| `embedTimeout` | `OPENAI_EMBED_TIMEOUT` |  -  |
| `embedRetries` | `OPENAI_EMBED_RETRIES` | `0` |
| `embedRetryDelay` | `OPENAI_EMBED_RETRY_DELAY` | `1000` |
| `headers` |  -  |  -  |
| `fetch` |  -  | `globalThis.fetch` |

### Ollama (local, zero cost)

```javascript
const db = new Skalex({
  path: "./data",
  ai: {
    provider: "ollama",
    embedModel: "nomic-embed-text",       // default  -  768 dimensions; or set OLLAMA_EMBED_MODEL env var
    host: "http://localhost:11434",       // default; or set OLLAMA_HOST env var
  },
});
```

| `ai` field | Env var | Default |
|------------|---------|---------|
| `embedModel` | `OLLAMA_EMBED_MODEL` | `"nomic-embed-text"` |
| `host` | `OLLAMA_HOST` | `"http://localhost:11434"` |
| `embedTimeout` | `OLLAMA_EMBED_TIMEOUT` |  -  |
| `embedRetries` | `OLLAMA_EMBED_RETRIES` | `0` |
| `embedRetryDelay` | `OLLAMA_EMBED_RETRY_DELAY` | `1000` |
| `headers` |  -  |  -  |
| `fetch` |  -  | `globalThis.fetch` |

Run locally: `ollama pull nomic-embed-text`

### Custom Adapter

```javascript
class MyEmbeddingAdapter {
  async embed(text) {
    // call your embedding API
    return [0.1, 0.2, ...]; // number[]
  }
}

const db = new Skalex({
  path: "./data",
  embeddingAdapter: new MyEmbeddingAdapter(),
});
```

---

## Language Model Adapters

Enable `db.ask()` and `memory.compress()` by providing a `model` in the `ai` config. The same `ai` object controls both embedding and language model; use `embedModel` to pin the embedding model separately.

Import via the connectors subpackage (npm + bundler):

```javascript
import { OpenAILLMAdapter, AnthropicLLMAdapter, OllamaLLMAdapter } from 'skalex/connectors/llm';
// Or from the root barrel
import { OpenAILLMAdapter, AnthropicLLMAdapter, OllamaLLMAdapter } from 'skalex/connectors';
```

> **Cost & availability:** `db.ask()` and `memory.compress()` send prompts to the configured LLM and **incur charges** for OpenAI and Anthropic providers. Token consumption depends on collection schema size and memory history length. Use the Ollama adapter for a fully local, zero-cost setup.

### OpenAI

```javascript
const db = new Skalex({
  ai: {
    provider: "openai",
    apiKey: process.env.OPENAI_KEY,       // or set OPENAI_API_KEY env var
    embedModel: "text-embedding-3-small", // default; or set OPENAI_EMBED_MODEL env var
    model: "gpt-4o-mini",                 // default LLM; or set OPENAI_MODEL env var
  },
});
```

To use a proxy or an OpenAI-compatible API, pass `baseUrl`:

```javascript
ai: {
  provider: "openai",
  apiKey: process.env.OPENAI_KEY,
  baseUrl: "https://my-proxy.com/v1/chat/completions", // or set OPENAI_BASE_URL env var
}
```

| `ai` field | Env var | Default |
|------------|---------|---------|
| `apiKey` | `OPENAI_API_KEY` |  -  |
| `model` | `OPENAI_MODEL` | `"gpt-4o-mini"` |
| `baseUrl` | `OPENAI_BASE_URL` | `"https://api.openai.com/v1/chat/completions"` |
| `maxTokens` | `OPENAI_MAX_TOKENS` |  -  |
| `temperature` | `OPENAI_TEMPERATURE` | `0.3` |
| `topP` | `OPENAI_TOP_P` |  -  |
| `organization` | `OPENAI_ORGANIZATION` |  -  |
| `timeout` | `OPENAI_TIMEOUT` |  -  |
| `retries` | `OPENAI_RETRIES` | `0` |
| `retryDelay` | `OPENAI_RETRY_DELAY` | `1000` |
| `seed` | `OPENAI_SEED` |  -  |
| `generatePrompt` |  -  | built-in |
| `summarizePrompt` |  -  | built-in |
| `headers` |  -  |  -  |
| `fetch` |  -  | `globalThis.fetch` |

### Anthropic

```javascript
const db = new Skalex({
  ai: {
    provider: "anthropic",
    apiKey: process.env.ANTHROPIC_KEY,    // or set ANTHROPIC_API_KEY env var
    model: "claude-haiku-4-5",            // default; or set ANTHROPIC_MODEL env var
  },
});
```

| `ai` field | Env var | Default |
|------------|---------|---------|
| `apiKey` | `ANTHROPIC_API_KEY` |  -  |
| `model` | `ANTHROPIC_MODEL` | `"claude-haiku-4-5"` |
| `baseUrl` | `ANTHROPIC_BASE_URL` | `"https://api.anthropic.com/v1/messages"` |
| `apiVersion` |  -  | `"2023-06-01"` |
| `maxTokens` | `ANTHROPIC_MAX_TOKENS` | `1024` |
| `temperature` | `ANTHROPIC_TEMPERATURE` | `0.3` |
| `topP` | `ANTHROPIC_TOP_P` |  -  |
| `topK` | `ANTHROPIC_TOP_K` |  -  |
| `timeout` | `ANTHROPIC_TIMEOUT` |  -  |
| `retries` | `ANTHROPIC_RETRIES` | `0` |
| `retryDelay` | `ANTHROPIC_RETRY_DELAY` | `1000` |
| `generatePrompt` |  -  | built-in |
| `summarizePrompt` |  -  | built-in |
| `headers` |  -  |  -  |
| `fetch` |  -  | `globalThis.fetch` |

### Ollama (local, zero cost)

```javascript
const db = new Skalex({
  ai: {
    provider: "ollama",
    embedModel: "nomic-embed-text",       // or set OLLAMA_EMBED_MODEL env var
    model: "llama3.2",                    // default; or set OLLAMA_MODEL env var
    host: "http://localhost:11434",       // default; or set OLLAMA_HOST env var
  },
});
```

| `ai` field | Env var | Default |
|------------|---------|---------|
| `model` | `OLLAMA_MODEL` | `"llama3.2"` |
| `host` | `OLLAMA_HOST` | `"http://localhost:11434"` |
| `temperature` | `OLLAMA_TEMPERATURE` | `0.3` |
| `topP` | `OLLAMA_TOP_P` |  -  |
| `topK` | `OLLAMA_TOP_K` |  -  |
| `timeout` | `OLLAMA_TIMEOUT` |  -  |
| `retries` | `OLLAMA_RETRIES` | `0` |
| `retryDelay` | `OLLAMA_RETRY_DELAY` | `1000` |
| `generatePrompt` |  -  | built-in |
| `summarizePrompt` |  -  | built-in |
| `headers` |  -  |  -  |
| `fetch` |  -  | `globalThis.fetch` |

Run locally: `ollama pull llama3.2`

---

## Class: Memory

Episodic agent memory backed by a `_memory_<sessionId>` collection. Obtain via `db.useMemory(sessionId)`.

### `remember(text)`

Stores a text entry with a semantic embedding.

**Returns:** `Promise<Document>`

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

**Returns:** `Promise<Document | null>`

### `tokenCount()`

Returns a rough token estimate of all stored memories (chars ÷ 4 heuristic).

**Returns:** `{ tokens: number, count: number }`

### `context(options?)`

Returns a newline-joined string of the most recent memories within a token budget, suitable for LLM context injection.

| Option | Type | Default |
|--------|------|---------|
| `tokens` | `number` | `4000` |

**Returns:** `string` (synchronous)

### `compress(options?)`

Summarises old memories using the language model adapter and replaces them with a single compressed entry. Recent entries are kept intact.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `threshold` | `number` | `8000` | Only compress when total token count exceeds this value (overrides `memory.compressionThreshold`) |
| `keepRecent` | `number` | `10` | Number of most recent entries to preserve (overrides `memory.keepRecent`) |

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

Accepts a custom transport object; useful for testing or embedding.

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

The default scope is `{ "*": ["read"] }`, giving **read-only access to all collections**. You must explicitly grant write access.

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

> **Security note:** MCP scopes control tool visibility but do **not** authenticate the connecting client. Any process that can reach the stdio pipe or HTTP port has full access within the granted scopes. Never expose the HTTP transport on a public interface without an external authentication layer, and always use the most restrictive scopes needed.

For the HTTP transport, CORS is **disabled by default**. Enable it only if you need browser-based MCP clients:

```javascript
const server = db.mcp({
  transport: "http",
  allowedOrigin: "http://localhost:5173", // or "*" for any origin
});
```

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

At-rest encryption using AES-256-GCM via `globalThis.crypto.subtle`. Works in Node ≥ 18, Bun, Deno, and all modern browsers; zero extra dependencies.

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

> **Key loss = permanent data loss.** There is no key recovery mechanism. If the encryption key is lost, all data encrypted with it is **irrecoverable**. Store your key in a secrets manager (e.g. AWS Secrets Manager, Vault, 1Password Secrets Automation) and never hardcode it in source code or commit it to version control.

> **Unencrypted by default.** Without the `encrypt` option, data files are stored as plain JSON or gzip on disk. Anyone with read access to the data directory can read all collection data. Enable encryption for any deployment that stores sensitive information.

### Composing with any adapter

`EncryptedAdapter` can wrap any storage adapter directly, letting you encrypt data in any environment  -  including the browser.

```javascript
import EncryptedAdapter from "skalex/connectors/encrypted";
import LocalStorageAdapter from "skalex/connectors/local";

// Wrap any adapter with AES-256-GCM encryption
const db = new Skalex({
  adapter: new EncryptedAdapter(
    new LocalStorageAdapter({ namespace: "myapp" }),
    process.env.DB_KEY  // 64-char hex string or 32-byte Uint8Array
  ),
});
```

This is equivalent to passing `encrypt: { key }` for `FsAdapter`, but lets you apply encryption to any adapter combination.

---

## Slow Query Log

```javascript
const db = new Skalex({
  path: "./data",
  slowQueryLog: {
    threshold:  50,   // ms  -  queries longer than this are recorded (default: 100)
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

## Plugin System

Plugins intercept database operations via pre/post hooks. Register with `db.use(plugin)` or pass `plugins` to the constructor.

```javascript
const auditPlugin = {
  async afterInsert({ collection, doc }) {
    await auditLog.write("insert", collection, doc._id);
  },
  async afterDelete({ collection, filter, result }) {
    await auditLog.write("delete", collection, result?._id);
  },
};

db.use(auditPlugin);
```

### Available Hooks

| Hook | Context properties |
|------|--------------------|
| `beforeInsert(ctx)` | `collection`, `doc` |
| `afterInsert(ctx)` | `collection`, `doc` (fully inserted, `_id` set) |
| `beforeUpdate(ctx)` | `collection`, `filter`, `update` |
| `afterUpdate(ctx)` | `collection`, `filter`, `update`, `result` |
| `beforeDelete(ctx)` | `collection`, `filter` |
| `afterDelete(ctx)` | `collection`, `filter`, `result` |
| `beforeFind(ctx)` | `collection`, `filter`, `options` |
| `afterFind(ctx)` | `collection`, `filter`, `options`, `docs` |
| `beforeSearch(ctx)` | `collection`, `query`, `options` |
| `afterSearch(ctx)` | `collection`, `query`, `options`, `docs`, `scores` |

All hooks are awaited in registration order. A hook that throws will propagate the error to the caller.

### Multiple plugins

```javascript
db.use(validationPlugin);
db.use(auditPlugin);
db.use(cacheInvalidationPlugin);
// all three fire in order for every operation
```

---

## Session Stats

Track reads and writes per session ID. Pass `session` on any operation; stats accumulate automatically.

```javascript
const db = new Skalex({ path: "./data" });
await db.connect();

const col = db.useCollection("orders");

// Tag writes
await col.insertOne({ item: "Widget" }, { session: "user-123" });
await col.updateOne({ item: "Widget" }, { qty: 2 }, { session: "user-123" });

// Tag reads
await col.find({}, { session: "user-123" });

// Retrieve stats
const s = db.sessionStats("user-123");
console.log(s.reads);      // 1
console.log(s.writes);     // 2
console.log(s.lastActive); // Date

// All sessions
const all = db.sessionStats();
// [{ sessionId: "user-123", reads: 1, writes: 2, lastActive: Date }]
```

The `session` option is supported on `insertOne`, `insertMany`, `updateOne`, `updateMany`, `deleteOne`, `deleteMany`, `find`, and `search`.

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

For long-running processes, configure a periodic sweep with `ttlSweepInterval`:

```javascript
const db = new Skalex({
  path: "./data",
  ttlSweepInterval: 60_000, // sweep every 60 seconds
});
await db.connect();
// sweep timer starts automatically; cleared on disconnect()
```

A default TTL can also be set at the collection level so individual inserts don't need the `ttl` option:

```javascript
const sessions = db.createCollection("sessions", { defaultTtl: "24h" });
await sessions.insertOne({ userId: "abc" }); // auto-expires in 24h
```

> **Timing caveat:** Documents past their `_expiresAt` timestamp are not removed in real time between sweeps; they remain in memory and are still queryable. For strict real-time expiry, set a short `ttlSweepInterval`.

---

## Performance & Index Selection

### How the query engine works

Every `find()` call is evaluated in two phases:

1. **Index phase**: if the filter targets an indexed field, the engine resolves the candidate set in O(1) by looking up the index map.
2. **Scan phase**: remaining filter predicates are applied to the candidate set (or the full collection if no index matched).

Without an index on a queried field, every document in the collection is scanned.

### When to add an index

| Situation | Action |
|-----------|--------|
| You filter by a field on every query (`role`, `status`, `userId`) | Add it to `indexes` on `createCollection` |
| You enforce no-duplicates on a field (`email`, `slug`) | Add `unique: true` in the schema; this also creates an index |
| You sort or paginate by a field frequently | Add the field to `indexes` |
| You only ever read the full collection (`find({})`) | No index needed |

```javascript
db.createCollection("orders", {
  schema: {
    userId: { type: "string", required: true },
    status: { type: "string", enum: ["pending", "paid", "cancelled"] },
  },
  // O(1) lookup for userId and status  -  no full scan for these fields
  indexes: ["userId", "status"],
});
```

### Diagnosing slow queries

Use the [Slow Query Log](#slow-query-log) to identify unindexed fields:

```javascript
const slow = db.slowQueries({ minDuration: 50, limit: 20 });
// entry.filter shows which fields were in the query  -  add the slow ones to indexes
for (const entry of slow) {
  console.log(entry.collection, entry.op, entry.duration + "ms", entry.filter);
}
```

### In-memory scale limits

All collections are held entirely in memory. There is no streaming or lazy-loading of documents. Practical limits depend on available RAM and document size:

| Documents | Avg doc size | Approx. RAM |
|-----------|-------------|-------------|
| 10,000    | 1 KB        | ~10 MB      |
| 100,000   | 1 KB        | ~100 MB     |
| 100,000   | 10 KB       | ~1 GB       |

For workloads exceeding ~100k documents or ~500 MB of data, consider the `BunSQLiteAdapter`, `LibSQLAdapter`, or `D1Adapter`; these keep data on disk and only load what is queried.

### Concurrency

Skalex is designed for **single-process** workloads. All reads and writes share one in-memory store; there is no locking, no WAL, and no distributed coordination. For multi-process or multi-tenant deployments, run a separate Skalex instance per process, or use the namespace API to isolate tenants within a single process.

---

## Builds & Runtime Compatibility

Skalex ships four pre-built artifacts in `dist/`:

| File | Format | Raw | Gzipped | Use |
|------|--------|-----|---------|-----|
| `dist/skalex.esm.js` | ESM | 173 KB | 39 KB | Node.js ≥18, Bun, Deno 2.x |
| `dist/skalex.esm.min.js` | ESM (minified) | 63 KB | 17 KB | Production ESM |
| `dist/skalex.cjs` | CJS | 173 KB | 39 KB | Node.js `require()`, CommonJS tooling |
| `dist/skalex.min.cjs` | CJS (minified) | 63 KB | 17 KB | Production CommonJS |
| `dist/skalex.browser.js` | ESM | 173 KB | 39 KB | Browser `<script type="module">` |
| `dist/skalex.umd.min.js` | IIFE (minified) | 63 KB | 17 KB | CDN default (`jsdelivr`, `unpkg`) |

The **browser build** inlines empty stubs for all `node:*` built-ins at build time using a Rollup plugin. This means no `import … from "node:fs"` lines appear in the bundle, so it loads cleanly in any browser without CORS errors.

**npm + bundler**  -  recommended for production apps; full tree-shaking across all adapter types:

```js
import Skalex from 'skalex';
import { FsAdapter, LocalStorageAdapter, EncryptedAdapter } from 'skalex/connectors';
import { OpenAIEmbeddingAdapter, OllamaEmbeddingAdapter }   from 'skalex/connectors/embedding';
import { OpenAILLMAdapter, AnthropicLLMAdapter }            from 'skalex/connectors/llm';
```

**CDN  -  ESM** (`<script type="module">`)  -  no bundler required; use the browser-specific barrel which exports only the browser-compatible adapters:

```html
<script type="module">
  import Skalex from "https://cdn.jsdelivr.net/npm/skalex@4.0.0-alpha.1/dist/skalex.browser.js";
  import { LocalStorageAdapter } from "https://cdn.jsdelivr.net/npm/skalex@4.0.0-alpha.1/src/connectors/storage/browser.js";
  // browser.js also exports EncryptedAdapter for AES-256-GCM at-rest encryption

  const db = new Skalex({ adapter: new LocalStorageAdapter({ namespace: "myapp" }) });
  await db.connect();

  const notes = db.useCollection("notes");
  await notes.insertOne({ title: "Hello", body: "World" });
  const { docs } = await notes.find();
  console.log(docs);
</script>
```

**CDN  -  IIFE** (`<script src>`, no `type="module"`)  -  exposes `window.Skalex`, for quick demos or when ESM is not an option. Connectors are not included; bring your own adapter:

```html
<!-- jsDelivr (recommended) -->
<script src="https://cdn.jsdelivr.net/npm/skalex@4.0.0-alpha.1"></script>

<!-- unpkg -->
<script src="https://unpkg.com/skalex@4.0.0-alpha.1"></script>

<script>
  // Skalex is available as window.Skalex
  // Provide your own storage adapter  -  LocalStorageAdapter is not bundled in the IIFE build.
  // For persistent storage in a real app, use the ESM CDN path above or install via npm.
  const db = new Skalex({ adapter: myAdapter });
  await db.connect();
</script>
```

Serves `dist/skalex.umd.min.js`.

The ESM build uses `node:` prefixed imports for all Node.js built-ins (`node:fs`, `node:path`, `node:zlib`, `node:crypto`, `node:http`). This is required by Deno 2.x and is the officially recommended form in Node.js ≥ 14.18 / ≥ 16.

### Cross-runtime Testing

Every release is verified by a 787-test suite across four runtimes:

```bash
npm run test:all       # Vitest (558) + smoke across Node, Bun, Deno, Chrome (229)

npm run smoke:node     # Node.js CJS dist
npm run smoke:bun      # Bun ESM dist + BunSQLiteAdapter
npm run smoke:deno     # Deno ESM dist
npm run smoke:browser  # Headless Chromium via Playwright (requires: npx playwright install chromium)
```

The browser smoke tests can also be opened manually in any browser for visual inspection:
- `tests/smoke/browser.html`  -  ESM build (`dist/skalex.browser.js`)
- `tests/smoke/browser-umd.html`  -  UMD/IIFE CDN build (`dist/skalex.umd.min.js`)

---

## Document Shape

Every document inserted by Skalex has the following system fields added automatically:

| Field | Type | When present | Description |
|-------|------|-------------|-------------|
| `_id` | `string` | Always | 24-character hex ID (timestamp + crypto random) |
| `createdAt` | `Date` | Always | Set once at insert time |
| `updatedAt` | `Date` | Always | Set at insert time, updated on every write |
| `_expiresAt` | `Date` | When `ttl` is set | TTL expiry timestamp |
| `_version` | `number` | When `versioning: true` | Starts at `1`; incremented on every update |
| `_deletedAt` | `Date` | When `softDelete: true` + deleted | Soft-delete timestamp; present only on deleted documents |
