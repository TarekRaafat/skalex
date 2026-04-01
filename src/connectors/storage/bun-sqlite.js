import StorageAdapter from "./base.js";

const _env = k => globalThis.process?.env?.[k] ?? globalThis.Deno?.env?.get(k);

/**
 * BunSQLiteAdapter  -  Bun-native SQLite storage backend via `bun:sqlite`.
 *
 * Uses Bun's built-in SQLite module  -  zero additional dependencies.
 * All collections are stored in a single SQLite file (or in-memory).
 *
 * Usage (Bun runtime only):
 *   import Skalex from "skalex";
 *   import BunSQLiteAdapter from "skalex/connectors/bun-sqlite";
 *
 *   const db = new Skalex({ adapter: new BunSQLiteAdapter("./data.db") });
 *   await db.connect();
 *
 * Environment variables (all optional  -  constructor config takes precedence):
 *   SKALEX_TABLE   -  SQLite table name (default: "skalex_store")
 *
 * @param {string} [path=":memory:"]  - Path to the SQLite file, or ":memory:" for in-memory.
 * @param {object} [opts]
 * @param {string} [opts.table]       - Table name. Default: "skalex_store". Falls back to SKALEX_TABLE env var.
 */
class BunSQLiteAdapter extends StorageAdapter {
  constructor(path = ":memory:", { table = _env("SKALEX_TABLE") ?? "skalex_store" } = {}) {
    super();
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
      throw new Error(`BunSQLiteAdapter: invalid table name "${table}". Use only letters, digits, and underscores.`);
    }
    this._path  = path;
    this._table = table;
    /** @type {import("bun:sqlite").Database|null} */
    this._db    = null;
    this._stmts = null;
  }

  async _open() {
    if (this._db) return;
    // Dynamic import to avoid crashing in non-Bun environments
    const { Database } = await import("bun:sqlite");
    this._db = new Database(this._path);
    this._db.run(
      `CREATE TABLE IF NOT EXISTS ${this._table} (name TEXT PRIMARY KEY, data TEXT NOT NULL)`
    );
    this._stmts = {
      read:   this._db.prepare(`SELECT data FROM ${this._table} WHERE name = ?`),
      write:  this._db.prepare(`INSERT OR REPLACE INTO ${this._table} (name, data) VALUES (?, ?)`),
      delete: this._db.prepare(`DELETE FROM ${this._table} WHERE name = ?`),
      list:   this._db.prepare(`SELECT name FROM ${this._table}`),
    };
  }

  async read(name) {
    await this._open();
    const row = this._stmts.read.get(name);
    return row ? row.data : null;
  }

  async write(name, data) {
    await this._open();
    this._stmts.write.run(name, data);
  }

  async delete(name) {
    await this._open();
    this._stmts.delete.run(name);
  }

  async list() {
    await this._open();
    return this._stmts.list.all().map((r) => r.name);
  }

  /** Close the underlying SQLite connection. */
  close() {
    if (this._db) {
      this._db.close();
      this._db = null;
      this._stmts = null;
    }
  }
}

export default BunSQLiteAdapter;
