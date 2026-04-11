/**
 * migrations.js  -  versioned schema migrations.
 *
 * Migrations are registered with db.addMigration({ version, up }).
 * On connect(), each pending migration runs inside its own transaction;
 * the migration's data writes and the applied-version record in `_meta`
 * are flushed atomically in a single `saveAtomic` batch.
 *
 * _meta collection stores: { _id: "migrations", appliedVersions: number[] }
 */

import { ValidationError } from "./errors.js";

class MigrationEngine {
  constructor() {
    /** @type {Array<{version: number, description?: string, up: Function}>} */
    this._migrations = [];
  }

  /**
   * Register a migration. The `up()` function runs during `db.connect()`
   * after data has been loaded, **inside a transaction**. It receives the
   * Skalex instance (transaction proxy) so callers use the standard
   * `db.useCollection(name)` API:
   *
   * ```js
   * db.addMigration({
   *   version: 1,
   *   up: async (db) => {
   *     const users = db.useCollection("users");
   *     await users.insertOne({ name: "admin" });
   *   },
   * });
   * ```
   *
   * **Atomicity.** Each migration runs in its own transaction. If `up()`
   * throws, the transaction rolls back every write it made and the
   * migration's version is NOT recorded in `_meta`. The same migration
   * will re-run on the next `connect()` from a clean slate, so crash
   * recovery is automatic. Earlier migrations that already committed are
   * preserved.
   *
   * Even so, prefer idempotent write patterns (`upsert`, check-before-mutate)
   * so a partially-rolled-back migration followed by a retry produces the
   * same final state as a clean run.
   *
   * @param {{ version: number, description?: string, up: (db: import("../index.js").default) => Promise<void> }} migration
   */
  add(migration) {
    const { version, up } = migration;
    if (typeof version !== "number" || version < 1) {
      throw new ValidationError("ERR_SKALEX_VALIDATION_MIGRATION", `Migration version must be a positive integer, got ${version}`, { version });
    }
    if (typeof up !== "function") {
      throw new ValidationError("ERR_SKALEX_VALIDATION_MIGRATION", `Migration version ${version} must have an "up" function`, { version });
    }
    if (this._migrations.some(m => m.version === version)) {
      throw new ValidationError("ERR_SKALEX_VALIDATION_MIGRATION_DUPLICATE", `Migration version ${version} is already registered`, { version });
    }
    this._migrations.push({ ...migration });
    this._migrations.sort((a, b) => a.version - b.version);
  }

  /**
   * Run all pending migrations in order, each inside its own transaction.
   *
   * Atomicity contract
   * ------------------
   * Each migration's version is recorded in `_meta` **inside** the same
   * transaction that commits the migration's data writes. Both reach disk
   * in the same `saveAtomic()` batch, so a crash between "data committed"
   * and "version recorded" is impossible: either both land or neither does.
   *
   * @param {object} hooks
   * @param {(fn: (db: any) => Promise<void>) => Promise<void>} hooks.runInTx
   *   Wrapper that runs `fn(dbProxy)` inside a transaction boundary. If
   *   `fn` throws, the transaction must roll back. In production this is
   *   bound to `(fn) => skalex.transaction(fn)`; tests may pass a simpler
   *   wrapper that forwards a raw db instance.
   * @param {(versions: number[]) => void} hooks.recordApplied
   *   Called inside the transaction callback after `migration.up()` returns
   *   successfully. Records the full applied-versions list in the active
   *   transaction's `_meta` so it is flushed atomically with migration data.
   * @param {number[]} appliedVersions - already-applied versions from _meta
   * @returns {Promise<number[]>} The new full list of applied versions.
   *   If a migration fails, the returned list reflects the migrations that
   *   committed successfully before the failure; the error is re-thrown.
   */
  async run({ runInTx, recordApplied }, appliedVersions = []) {
    const applied = new Set(appliedVersions);
    const pending = this._migrations.filter(m => !applied.has(m.version));

    for (const migration of pending) {
      // Each migration runs in its own transaction. On failure, the
      // transaction rolls back every write the migration made AND the
      // _meta version record (because recordApplied snapshots _meta into
      // the active tx before mutating it). Earlier migrations that
      // committed successfully remain applied.
      await runInTx(async (db) => {
        await migration.up(db);
        // Publish the new applied-versions list inside the transaction
        // so saveAtomic flushes it in the same batch as migration data.
        const next = [...applied, migration.version].sort((a, b) => a - b);
        recordApplied(next);
      });
      applied.add(migration.version);
    }

    return [...applied].sort((a, b) => a - b);
  }

  /**
   * @returns {{ pending: number[], applied: number[], current: number }}
   */
  status(appliedVersions = []) {
    const applied = new Set(appliedVersions);
    const all = this._migrations.map(m => m.version);
    const pending = all.filter(v => !applied.has(v));
    const current = appliedVersions.length ? Math.max(...appliedVersions) : 0;
    return { current, applied: [...applied].sort((a, b) => a - b), pending };
  }
}

export default MigrationEngine;
