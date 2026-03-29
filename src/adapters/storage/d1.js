const StorageAdapter = require("./base");

/**
 * D1Adapter — Cloudflare D1 (SQLite-compatible) storage backend.
 *
 * Stores all collections in a single table:
 *   skalex_store (name TEXT PRIMARY KEY, data TEXT NOT NULL)
 *
 * Usage (Cloudflare Worker):
 *   import Skalex from "skalex";
 *   import { D1Adapter } from "skalex/adapters";
 *
 *   export default {
 *     async fetch(request, env) {
 *       const db = new Skalex({ adapter: new D1Adapter(env.DB) });
 *       await db.connect();
 *       // ...
 *     }
 *   };
 *
 * @param {D1Database} d1 - The D1 binding from your Worker environment.
 */
class D1Adapter extends StorageAdapter {
  constructor(d1) {
    super();
    if (!d1) throw new TypeError("D1Adapter: a D1Database binding is required.");
    this._d1 = d1;
    this._ready = false;
  }

  async _ensureTable() {
    if (this._ready) return;
    await this._d1
      .prepare(
        "CREATE TABLE IF NOT EXISTS skalex_store (name TEXT PRIMARY KEY, data TEXT NOT NULL)"
      )
      .run();
    this._ready = true;
  }

  async read(name) {
    await this._ensureTable();
    const row = await this._d1
      .prepare("SELECT data FROM skalex_store WHERE name = ?")
      .bind(name)
      .first();
    return row ? row.data : null;
  }

  async write(name, data) {
    await this._ensureTable();
    await this._d1
      .prepare(
        "INSERT OR REPLACE INTO skalex_store (name, data) VALUES (?, ?)"
      )
      .bind(name, data)
      .run();
  }

  async delete(name) {
    await this._ensureTable();
    await this._d1
      .prepare("DELETE FROM skalex_store WHERE name = ?")
      .bind(name)
      .run();
  }

  async list() {
    await this._ensureTable();
    const result = await this._d1
      .prepare("SELECT name FROM skalex_store")
      .all();
    return (result.results || []).map((r) => r.name);
  }
}

module.exports = D1Adapter;
