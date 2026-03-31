import StorageAdapter from "./base.js";

const _env = k => globalThis.process?.env?.[k] ?? globalThis.Deno?.env?.get(k);

/**
 * D1Adapter — Cloudflare D1 (SQLite-compatible) storage backend.
 *
 * Stores all collections in a single table.
 *
 * Usage (Cloudflare Worker):
 *   import Skalex from "skalex";
 *   import D1Adapter from "skalex/connectors/d1";
 *
 *   export default {
 *     async fetch(request, env) {
 *       const db = new Skalex({ adapter: new D1Adapter(env.DB) });
 *       await db.connect();
 *       // ...
 *     }
 *   };
 *
 * Environment variables (all optional — constructor config takes precedence):
 *   SKALEX_TABLE  — table name (default: "skalex_store")
 *
 * @param {D1Database} d1       - The D1 binding from your Worker environment.
 * @param {object}     [opts]
 * @param {string}     [opts.table] - Table name. Default: "skalex_store". Falls back to SKALEX_TABLE env var.
 */
class D1Adapter extends StorageAdapter {
  constructor(d1, { table = _env("SKALEX_TABLE") ?? "skalex_store" } = {}) {
    super();
    if (!d1) throw new TypeError("D1Adapter: a D1Database binding is required.");
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
      throw new Error(`D1Adapter: invalid table name "${table}". Use only letters, digits, and underscores.`);
    }
    this._d1    = d1;
    this._table = table;
    this._ready = false;
  }

  async _ensureTable() {
    if (this._ready) return;
    await this._d1
      .prepare(
        `CREATE TABLE IF NOT EXISTS ${this._table} (name TEXT PRIMARY KEY, data TEXT NOT NULL)`
      )
      .run();
    this._ready = true;
  }

  async read(name) {
    await this._ensureTable();
    const row = await this._d1
      .prepare(`SELECT data FROM ${this._table} WHERE name = ?`)
      .bind(name)
      .first();
    return row ? row.data : null;
  }

  async write(name, data) {
    await this._ensureTable();
    await this._d1
      .prepare(
        `INSERT OR REPLACE INTO ${this._table} (name, data) VALUES (?, ?)`
      )
      .bind(name, data)
      .run();
  }

  async delete(name) {
    await this._ensureTable();
    await this._d1
      .prepare(`DELETE FROM ${this._table} WHERE name = ?`)
      .bind(name)
      .run();
  }

  async list() {
    await this._ensureTable();
    const result = await this._d1
      .prepare(`SELECT name FROM ${this._table}`)
      .all();
    return (result.results || []).map((r) => r.name);
  }
}

export default D1Adapter;
