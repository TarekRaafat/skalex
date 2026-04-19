import StorageAdapter from "./base.js";
import { AdapterError } from "../../engine/errors.js";

const _env = k => globalThis.process?.env?.[k] ?? globalThis.Deno?.env?.get(k);

/** Cloudflare D1's documented per-batch statement limit. */
const D1_MAX_BATCH_SIZE = 1000;

/**
 * D1Adapter  -  Cloudflare D1 (SQLite-compatible) storage backend.
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
 * Environment variables (all optional  -  constructor config takes precedence):
 *   SKALEX_TABLE   -  table name (default: "skalex_store")
 *
 * @param {D1Database} d1              - The D1 binding from your Worker environment.
 * @param {object}     [opts]
 * @param {string}     [opts.table]     - Table name. Default: "skalex_store". Falls back to SKALEX_TABLE env var.
 * @param {number}     [opts.batchSize] - Max statements per `d1.batch()` call. Default: 1000,
 *                                        matching Cloudflare D1's documented per-batch limit.
 *                                        Each chunk is an atomic batch; failures in a later
 *                                        chunk do not roll back earlier chunks. Override with
 *                                        a smaller value only if you need finer-grained
 *                                        progress tracking.
 */
class D1Adapter extends StorageAdapter {
  constructor(d1, { table = _env("SKALEX_TABLE") ?? "skalex_store", batchSize = D1_MAX_BATCH_SIZE } = {}) {
    super();
    if (!d1) {
      throw new AdapterError(
        "ERR_SKALEX_ADAPTER_D1_BINDING_REQUIRED",
        "D1Adapter: a D1Database binding is required."
      );
    }
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
      throw new AdapterError(
        "ERR_SKALEX_ADAPTER_D1_INVALID_TABLE",
        `D1Adapter: invalid table name "${table}". Use only letters, digits, and underscores.`,
        { table }
      );
    }
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new AdapterError(
        "ERR_SKALEX_ADAPTER_D1_INVALID_BATCH_SIZE",
        `D1Adapter: invalid batchSize "${batchSize}". Must be a positive integer.`,
        { batchSize }
      );
    }
    if (batchSize > D1_MAX_BATCH_SIZE) {
      throw new AdapterError(
        "ERR_SKALEX_ADAPTER_D1_INVALID_BATCH_SIZE",
        `D1Adapter: batchSize ${batchSize} exceeds Cloudflare D1's documented per-batch limit of ${D1_MAX_BATCH_SIZE}. Pick a smaller value.`,
        { batchSize, max: D1_MAX_BATCH_SIZE }
      );
    }
    this._d1        = d1;
    this._table     = table;
    this._batchSize = batchSize;
    this._ready     = false;
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

  get supportsBatch() { return true; }

  /**
   * Batch-write multiple collections.
   *
   * Each chunk of up to `batchSize` statements is atomic (D1 `batch()`
   * runs inside a single SQLite transaction). Cross-chunk atomicity is
   * NOT guaranteed: if chunk N fails, chunks 0..N-1 are already committed.
   *
   * When Cloudflare D1 Sessions API reaches GA, this method should wrap
   * all chunks in a single session so a failure in any chunk rolls back
   * earlier ones atomically. Tracked as alpha.4 #18.
   *
   * @param {{ name: string, data: string }[]} entries
   */
  async writeAll(entries) {
    await this._ensureTable();
    if (entries.length === 0) return;
    const size = this._batchSize;
    for (let i = 0; i < entries.length; i += size) {
      const chunk = entries.slice(i, i + size);
      const stmts = chunk.map(({ name, data }) =>
        this._d1
          .prepare(`INSERT OR REPLACE INTO ${this._table} (name, data) VALUES (?, ?)`)
          .bind(name, data)
      );
      await this._d1.batch(stmts);
    }
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
