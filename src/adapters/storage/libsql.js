const StorageAdapter = require("./base");

/**
 * LibSQLAdapter — LibSQL / Turso storage backend.
 *
 * Works with any `@libsql/client`-compatible client — local files, embedded
 * replicas, or Turso remote databases.
 * All collections are stored in a single table:
 *   skalex_store (name TEXT PRIMARY KEY, data TEXT NOT NULL)
 *
 * Usage:
 *   import { createClient } from "@libsql/client";
 *   import Skalex from "skalex";
 *   import { LibSQLAdapter } from "skalex/adapters";
 *
 *   const client = createClient({ url: "libsql://your-db.turso.io", authToken: "..." });
 *   const db = new Skalex({ adapter: new LibSQLAdapter(client) });
 *   await db.connect();
 *
 * For local-only usage:
 *   const client = createClient({ url: "file:./data.db" });
 *
 * @param {import("@libsql/client").Client} client - A libsql client instance.
 */
class LibSQLAdapter extends StorageAdapter {
  constructor(client) {
    super();
    if (!client) throw new TypeError("LibSQLAdapter: a libsql client is required.");
    this._client = client;
    this._ready = false;
  }

  async _ensureTable() {
    if (this._ready) return;
    await this._client.execute(
      "CREATE TABLE IF NOT EXISTS skalex_store (name TEXT PRIMARY KEY, data TEXT NOT NULL)"
    );
    this._ready = true;
  }

  async read(name) {
    await this._ensureTable();
    const result = await this._client.execute({
      sql: "SELECT data FROM skalex_store WHERE name = ?",
      args: [name],
    });
    return result.rows.length > 0 ? result.rows[0].data : null;
  }

  async write(name, data) {
    await this._ensureTable();
    await this._client.execute({
      sql: "INSERT OR REPLACE INTO skalex_store (name, data) VALUES (?, ?)",
      args: [name, data],
    });
  }

  async delete(name) {
    await this._ensureTable();
    await this._client.execute({
      sql: "DELETE FROM skalex_store WHERE name = ?",
      args: [name],
    });
  }

  async list() {
    await this._ensureTable();
    const result = await this._client.execute(
      "SELECT name FROM skalex_store"
    );
    return result.rows.map((r) => r.name);
  }
}

module.exports = LibSQLAdapter;
