<div class="cover">

<div>
<img src="./imgs/skalex_banner.png" alt= "Skalex Logo" id="logo">

<br>

![100% Javascript](https://img.shields.io/github/languages/top/TarekRaafat/skalex?color=yellow)
![Zero Dependencies](https://img.shields.io/badge/Dependencies-0-blue.svg)
[![Minified Size](https://badgen.net/bundlephobia/min/skalex)](https://bundlephobia.com/package/skalex)
[![npm](https://img.shields.io/npm/dm/skalex?label=npm)](https://www.npmjs.com/package/skalex)
[![Yes Maintained](https://img.shields.io/badge/Maintained%3F-yes-success)](https://github.com/TarekRaafat/skalex)
[![Open Source Love](https://badges.frapsoft.com/os/v1/open-source.svg?v=103)](https://github.com/TarekRaafat/skalex)

<div class="sharethis-inline-share-buttons"></div>

<a href="#/?id=skalex" class="link no-underline"><span class="ps-icon ps-icon-down"></span></a>

</div>

</div>

---

# Skalex <!-- {docsify-ignore} -->

> AI-first · Isomorphic · Zero-dependency · Local-first JavaScript database :rocket:

## What is Skalex? <!-- {docsify-ignore} -->

`Skalex` is a powerful JavaScript database library designed for modern, local-first applications. It runs in Node.js, browsers, Bun, and edge runtimes with zero external dependencies, delivering a full document-database experience wherever JavaScript runs. <sub><sup>(Made for a better developer experience)</sub></sup>

## Features <!-- {docsify-ignore} -->

- Pure Vanilla JavaScript — zero runtime dependencies
- Isomorphic — Node.js, browser, Bun, Deno, edge
- Dual ESM/CJS build (`dist/skalex.esm.js` + `dist/skalex.cjs.js`)
- Full TypeScript definitions included
- All CRUD operations <sub><sup>(Create, Read, Update, Delete)</sub></sup>
- Secondary field indexes — O(1) lookups
- Unique index constraints
- Schema validation with type, required, unique, and enum rules
- TTL documents — auto-expiry with `_expiresAt`
- Versioned migrations with `_meta` tracking
- Atomic transactions — snapshot + commit/rollback
- Relational collections <sub><sup>(populate: one-to-one & one-to-many)</sub></sup>
- Pluggable storage adapters — `FsAdapter`, `LocalStorageAdapter`, or bring your own
- Query operators: `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$regex`, `$fn`

<details>
<summary>More details</summary>

<br>

1. **Isomorphic & Adapter-based Storage:**
   - Skalex abstracts all I/O behind a `StorageAdapter` interface. The built-in `FsAdapter` targets Node.js with atomic temp-file-then-rename writes. The `LocalStorageAdapter` targets browsers. You can pass any custom adapter to target edge runtimes, Bun, or in-memory environments.
2. **Zero Setup Required:**
   - No database server, no configuration files, no migrations to run manually. Connect and start inserting.
3. **Secondary Indexes & Unique Constraints:**
   - Declare indexed fields on `createCollection()` for O(1) query performance. Mark fields `unique: true` to enforce no-duplicate constraints automatically on insert and update.
4. **Schema Validation:**
   - Define schemas with type checking, required fields, enum constraints, and unique rules. Validation runs at insert/update time with clear error messages.
5. **TTL Documents:**
   - Set a `ttl` option on any insert — `'30m'`, `'24h'`, `'7d'`, or a number of seconds. Expired documents are swept automatically on `connect()`.
6. **Migrations:**
   - Register versioned migration functions with `db.addMigration({ version, up })`. Pending migrations run automatically on `connect()` and applied versions are tracked in `_meta`.
7. **Atomic Transactions:**
   - `db.transaction(fn)` snapshots all in-memory state before running your callback. If the callback throws, every change is rolled back automatically.
8. **Relational Collections:**
   - Link collections via `populate` on `find`/`findOne`. Build one-to-one and one-to-many relationships without a query language.
9. **Rich Query Engine:**
   - Filter with plain objects, query operators, dot-notation for nested fields, RegExp, or custom `$fn` functions. The filter pre-sorter evaluates indexed fields first for maximum performance.
10. **Export & Import:**
    - Export filtered collection data to JSON or CSV via the storage adapter. Import JSON or CSV files back into any collection.

</details>

## Why use Skalex? <!-- {docsify-ignore} -->

<details>

<summary>Reasons to use Skalex over MongoDB, SQL, PostgreSQL, and other databases</summary>

<br>

1. **No External Dependencies:** Skalex ships zero runtime dependencies. No driver, no ORM, no server process.
2. **Runs Everywhere:** The same API works in Node.js, browsers (via `LocalStorageAdapter`), Bun, Deno, and edge runtimes by swapping the storage adapter.
3. **Local-first & Offline:** Data lives on the local file system or in `localStorage`. No network required. Ideal for desktop apps, CLI tools, AI agents, and edge deployments.
4. **AI-first Design:** Structured local storage, TTL documents, and versioned migrations make Skalex a natural fit for agent memory, MCP servers, and model context management.
5. **Instant Setup:** `new Skalex({ path: "./.db" })` + `await db.connect()` is all the setup you need.
6. **TypeScript Ready:** Full generics, mapped types, and union types ship in the box — no `@types/` package needed.
7. **Predictable Performance:** Secondary indexes guarantee O(1) field lookups. The filter pre-sorter minimises unnecessary work on every query.
8. **Safe by Default:** Atomic writes prevent corrupt files on crash. Unique index constraints prevent duplicate data. Schema validation prevents bad data at the boundary.

<br>

> **Disclaimer:** Skalex is optimised for local-first, single-process workloads. It is not designed for high-concurrency multi-process deployments or distributed systems.

</details>

## Author <!-- {docsify-ignore} -->

<div class="ps-icon ps-icon-guy-big-smile"></div> <b>Tarek Raafat</b>

- Email: tarek.m.raafat@gmail.com
- Github: [github.com/TarekRaafat](https://github.com/TarekRaafat/)

## License <!-- {docsify-ignore} -->

`Skalex` is released under the [Apache 2.0 license](https://www.apache.org/licenses/LICENSE-2.0).

© 2023 [Tarek Raafat](http://www.tarekraafat.com)
