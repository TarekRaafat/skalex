<img src="./docs/imgs/skalex_banner.png" alt= "skalex Logo" id="logo">

<br>

# Skalex

[![GitHub package.json version](https://img.shields.io/github/package-json/v/TarekRaafat/skalex)](https://github.com/TarekRaafat/skalex)
[![npm](https://img.shields.io/npm/v/skalex)](https://www.npmjs.com/package/skalex)
![100% Javascript](https://img.shields.io/github/languages/top/TarekRaafat/skalex?color=yellow)
![Zero Dependencies](https://img.shields.io/badge/Dependencies-0-blue.svg)
![Yes Maintained](https://img.shields.io/badge/Maintained%3F-yes-success)
[![npm](https://img.shields.io/npm/dm/skalex?label=npm)](https://www.npmjs.com/package/skalex)
[![Open Source Love](https://badges.frapsoft.com/os/v1/open-source.svg?v=103)](https://github.com/TarekRaafat/skalex)

**AI-first · Isomorphic · Zero-dependency · Local-first**

> The only JavaScript database with native vector search, schema validation, TTL, migrations, and transactions — all in one zero-dependency package that runs everywhere.

---

## Features

**Core**
- **Zero dependencies** — no install footprint beyond the package itself
- **Dual ESM / CJS build** — `import` or `require`, TypeScript definitions included
- **Runs everywhere** — Node.js ≥18, Bun, Deno, browser, edge runtimes
- **Pluggable storage** — `FsAdapter` (Node), `LocalStorageAdapter` (browser), `EncryptedAdapter` (AES-256-GCM), or bring your own

**Query**
- Full operator set: `$eq` `$ne` `$gt` `$gte` `$lt` `$lte` `$in` `$nin` `$regex` `$fn`
- Dot-notation nested field queries
- Secondary field indexes — O(1) lookups via `IndexEngine`
- Unique constraints, filter pre-sorter for performance

**Schema & Integrity**
- Zero-dependency schema validation — `type`, `required`, `unique`, `enum`
- Versioned migrations — `addMigration({ version, up })`, auto-run on `connect()`
- TTL documents — `insertOne(doc, { ttl: "30m" })`, swept on connect
- Transactions — snapshot + commit / rollback
- Change log — `createCollection(name, { changelog: true })`, point-in-time restore

**Vector Search**
- `insertOne / insertMany` with `{ embed: "field" }` — auto-embed on insert
- `collection.search(query, { filter, limit, minScore })` — cosine similarity + hybrid
- `collection.similar(id)` — nearest-neighbour lookup
- `db.embed(text)` — direct embedding access
- Built-in adapters: **OpenAI** (`text-embedding-3-small`) and **Ollama** (local, zero cost)

**AI-Native**
- `db.ask(collection, nlQuery)` — translate natural language to a filter via LLM; results cached
- `db.useMemory(sessionId)` — episodic agent memory with `remember`, `recall`, `context`, `compress`
- Built-in language model adapters: **OpenAI**, **Anthropic**, **Ollama**
- `db.schema(collection)` — infer or return declared schema as a plain object

**Aggregation & Observability**
- `collection.count / sum / avg / groupBy` — aggregation with optional filter and dot-notation
- `db.stats(collection?)` — count, estimated size, average doc size
- `slowQueryLog` option + `db.slowQueries()` — capture slow `find` and `search` calls

**Reactive**
- `collection.watch(filter?, callback?)` — observe mutations; callback or `AsyncIterableIterator`
- Events: `{ op, collection, doc, prev? }` emitted after every insert, update, delete

**MCP Server**
- `db.mcp(opts)` — expose the database as MCP tools for AI agents
- Compatible with **Claude Desktop**, **Cursor**, and any MCP client
- `stdio` transport (default) and `http + SSE` transport
- Tools: `find`, `insert`, `update`, `delete`, `search`, `ask`, `schema`, `collections`
- Access control: `scopes` map per collection — `read` / `write` / `admin`

**Plugin System**
- `db.use(plugin)` — register pre/post hooks on all operations
- Hooks: `beforeInsert`, `afterInsert`, `beforeUpdate`, `afterUpdate`, `beforeDelete`, `afterDelete`, `beforeFind`, `afterFind`, `beforeSearch`, `afterSearch`
- All hooks awaited in order; errors propagate to the caller

**Session Stats**
- `db.sessionStats(sessionId?)` — reads, writes, lastActive per session
- `session` option on all reads and writes — automatic accumulation

**Edge & SQLite Adapters**
- `D1Adapter` — Cloudflare D1 / Workers edge SQLite
- `BunSQLiteAdapter` — Bun-native `bun:sqlite`; `:memory:` or file path
- `LibSQLAdapter` — LibSQL / Turso client adapter

**Developer Experience**
- `db.transaction(fn)` — atomic multi-collection writes
- `db.seed(fixtures)` — idempotent fixture seeding
- `db.dump()` / `db.inspect()` — snapshot and metadata
- `db.namespace(id)` — isolated sub-instances per tenant / user
- `db.import(path)` — JSON / CSV import
- `collection.upsert()`, `insertOne({ ifNotExists })` — safe idempotent writes
- `encrypt: { key }` — AES-256-GCM at-rest encryption, transparent to all callers
- `session` option on all reads and writes — audit trail + session stats
- `debug: true` — connect/disconnect logging

---

## Installation

```bash
npm install skalex
```

Requires **Node.js ≥ 18**.

---

## Quick Start

```javascript
import Skalex from "skalex";

const db = new Skalex({ path: "./data", format: "json" });
await db.connect();

const users = db.useCollection("users");

const { data: alice } = await users.insertOne({ name: "Alice", role: "admin" });
const { docs }        = await users.find({ role: "admin" });
await users.updateOne({ name: "Alice" }, { score: { $inc: 10 } });
await users.deleteOne({ name: "Alice" });

await db.disconnect();
```

### With Vector Search

```javascript
import Skalex from "skalex";

const db = new Skalex({
  path: "./data",
  ai: { provider: "openai", apiKey: process.env.OPENAI_KEY },
});
await db.connect();

const articles = db.useCollection("articles");

await articles.insertMany([
  { title: "Intro to Skalex", content: "A zero-dependency JS database..." },
  { title: "Vector search 101", content: "Cosine similarity measures angle between vectors..." },
], { embed: "content" });

const { docs, scores } = await articles.search("how do I set up a JS database?", { limit: 2 });
console.log(docs[0].title); // most relevant result

await db.disconnect();
```

---

## Documentation

Full API reference, examples, and guides:

**[tarekraafat.github.io/skalex](https://tarekraafat.github.io/skalex/)** :notebook_with_decorative_cover:

---

## Support

- Stack Overflow: [stackoverflow.com/questions/tagged/skalex][stackOverflow]
- GitHub Discussions: [github.com/TarekRaafat/skalex/discussions][Discussions]

<!-- section links -->
[Discussions]: https://github.com/TarekRaafat/skalex/discussions
[stackoverflow]: https://stackoverflow.com/questions/tagged/skalex

---

## Author

**Tarek Raafat**

- Email: tarek.m.raafat@gmail.com
- Github: [github.com/TarekRaafat](https://github.com/TarekRaafat/)

---

## License

Released under the [Apache 2.0 license](https://www.apache.org/licenses/LICENSE-2.0).

© 2023 [Tarek Raafat](http://www.tarekraafat.com)
