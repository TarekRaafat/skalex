const StorageAdapter = require("./base");

/**
 * BunSQLiteAdapter — Bun-native SQLite storage backend via `bun:sqlite`.
 *
 * Uses Bun's built-in SQLite module — zero additional dependencies.
 * All collections are stored in a single SQLite file (or in-memory):
 *   skalex_store (name TEXT PRIMARY KEY, data TEXT NOT NULL)
 *
 * Usage (Bun runtime only):
 *   import Skalex from "skalex";
 *   import { BunSQLiteAdapter } from "skalex/adapters";
 *
 *   const db = new Skalex({ adapter: new BunSQLiteAdapter("./data.db") });
 *   await db.connect();
 *
 * @param {string} [path=":memory:"] - Path to the SQLite file, or ":memory:" for an in-memory database.
 */
class BunSQLiteAdapter extends StorageAdapter {
  constructor(path = ":memory:") {
    super();
    this._path = path;
    /** @type {import("bun:sqlite").Database|null} */
    this._db = null;
  }

  async _open() {
    if (this._db) return;
    // Dynamic import to avoid crashing in non-Bun environments
    const { Database } = await import("bun:sqlite");
    this._db = new Database(this._path);
    this._db.run(
      "CREATE TABLE IF NOT EXISTS skalex_store (name TEXT PRIMARY KEY, data TEXT NOT NULL)"
    );
  }

  async read(name) {
    await this._open();
    const row = this._db
      .prepare("SELECT data FROM skalex_store WHERE name = ?")
      .get(name);
    return row ? row.data : null;
  }

  async write(name, data) {
    await this._open();
    this._db
      .prepare(
        "INSERT OR REPLACE INTO skalex_store (name, data) VALUES (?, ?)"
      )
      .run(name, data);
  }

  async delete(name) {
    await this._open();
    this._db
      .prepare("DELETE FROM skalex_store WHERE name = ?")
      .run(name);
  }

  async list() {
    await this._open();
    return this._db
      .prepare("SELECT name FROM skalex_store")
      .all()
      .map((r) => r.name);
  }

  /** Close the underlying SQLite connection. */
  close() {
    if (this._db) {
      this._db.close();
      this._db = null;
    }
  }
}

module.exports = BunSQLiteAdapter;
