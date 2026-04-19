import StorageAdapter from "./base.js";
import { AdapterError } from "../../engine/errors.js";

const _env = k => globalThis.process?.env?.[k] ?? globalThis.Deno?.env?.get(k);

/**
 * LibSQLAdapter  -  LibSQL / Turso storage backend.
 *
 * Works with any `@libsql/client`-compatible client  -  local files, embedded
 * replicas, or Turso remote databases.
 * All collections are stored in a single table.
 *
 * Usage:
 *   import { createClient } from "@libsql/client";
 *   import Skalex from "skalex";
 *   import LibSQLAdapter from "skalex/connectors/libsql";
 *
 *   const client = createClient({ url: "libsql://your-db.turso.io", authToken: "..." });
 *   const db = new Skalex({ adapter: new LibSQLAdapter(client) });
 *   await db.connect();
 *
 * For local-only usage:
 *   const client = createClient({ url: "file:./data.db" });
 *
 * Environment variables (all optional  -  constructor config takes precedence):
 *   SKALEX_TABLE   -  table name (default: "skalex_store")
 *
 * @param {import("@libsql/client").Client} client - A libsql client instance.
 * @param {object} [opts]
 * @param {string} [opts.table] - Table name. Default: "skalex_store". Falls back to SKALEX_TABLE env var.
 */
class LibSQLAdapter extends StorageAdapter {
  constructor(client, { table = _env("SKALEX_TABLE") ?? "skalex_store" } = {}) {
    super();
    if (!client) throw new AdapterError("ERR_SKALEX_ADAPTER_LIBSQL_BINDING_REQUIRED", "LibSQLAdapter: a libsql client is required.");
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
      throw new AdapterError("ERR_SKALEX_ADAPTER_LIBSQL_INVALID_TABLE", `LibSQLAdapter: invalid table name "${table}". Use only letters, digits, and underscores.`);
    }
    this._client = client;
    this._table  = table;
    this._ready  = false;
  }

  async _ensureTable() {
    if (this._ready) return;
    await this._client.execute(
      `CREATE TABLE IF NOT EXISTS ${this._table} (name TEXT PRIMARY KEY, data TEXT NOT NULL)`
    );
    this._ready = true;
  }

  async read(name) {
    await this._ensureTable();
    const result = await this._client.execute({
      sql: `SELECT data FROM ${this._table} WHERE name = ?`,
      args: [name],
    });
    return result.rows.length > 0 ? result.rows[0].data : null;
  }

  async write(name, data) {
    await this._ensureTable();
    await this._client.execute({
      sql: `INSERT OR REPLACE INTO ${this._table} (name, data) VALUES (?, ?)`,
      args: [name, data],
    });
  }

  get supportsBatch() { return true; }

  async writeAll(entries) {
    await this._ensureTable();
    await this._client.batch(
      entries.map(({ name, data }) => ({
        sql: `INSERT OR REPLACE INTO ${this._table} (name, data) VALUES (?, ?)`,
        args: [name, data],
      }))
    );
  }

  async delete(name) {
    await this._ensureTable();
    await this._client.execute({
      sql: `DELETE FROM ${this._table} WHERE name = ?`,
      args: [name],
    });
  }

  async list() {
    await this._ensureTable();
    const result = await this._client.execute(
      `SELECT name FROM ${this._table}`
    );
    return result.rows.map((r) => r.name);
  }
}

export default LibSQLAdapter;
