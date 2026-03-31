/**
 * migrations.js — versioned schema migrations.
 *
 * Migrations are registered with db.addMigration({ version, up }).
 * On connect(), all pending migrations run in order, then state is saved to _meta.
 *
 * _meta collection stores: { _id: "migrations", appliedVersions: number[] }
 */

class MigrationEngine {
  constructor() {
    /** @type {Array<{version: number, description?: string, up: Function}>} */
    this._migrations = [];
  }

  /**
   * Register a migration.
   * @param {{ version: number, description?: string, up: (collection: Collection) => Promise<void> }} migration
   */
  add(migration) {
    const { version, up } = migration;
    if (typeof version !== "number" || version < 1) {
      throw new Error(`Migration version must be a positive integer, got ${version}`);
    }
    if (typeof up !== "function") {
      throw new Error(`Migration version ${version} must have an "up" function`);
    }
    if (this._migrations.some(m => m.version === version)) {
      throw new Error(`Migration version ${version} is already registered`);
    }
    this._migrations.push({ ...migration });
    this._migrations.sort((a, b) => a.version - b.version);
  }

  /**
   * Run all pending migrations in order.
   * @param {object} getCollection - function(name) → Collection instance
   * @param {number[]} appliedVersions - already-applied versions from _meta
   * @returns {Promise<number[]>} - the new full list of applied versions
   */
  async run(getCollection, appliedVersions = []) {
    const applied = new Set(appliedVersions);
    const pending = this._migrations.filter(m => !applied.has(m.version));

    for (const migration of pending) {
      const collection = getCollection(migration.version);
      await migration.up(collection);
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
