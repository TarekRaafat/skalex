/**
 * changelog.js — per-collection append-only mutation log.
 *
 * When a collection is created with { changelog: true }, every insert,
 * update, and delete is recorded in a shared _changelog collection.
 *
 * Entry shape:
 *   { op, collection, docId, doc, prev?, timestamp, session? }
 */
class ChangeLog {
  /**
   * @param {object} db  - Skalex instance
   */
  constructor(db) {
    this._db = db;
  }

  get _col() {
    return this._db.useCollection("_changelog");
  }

  /**
   * Record a mutation.
   * @param {"insert"|"update"|"delete"} op
   * @param {string} collection
   * @param {object} doc        - Document after the operation.
   * @param {object|null} [prev] - Document before the operation (updates only).
   * @param {string|null} [session]
   */
  async log(op, collection, doc, prev = null, session = null) {
    const entry = {
      op,
      collection,
      docId: doc._id,
      doc: { ...doc },
      timestamp: new Date(),
    };
    if (prev) entry.prev = { ...prev };
    if (session) entry.session = session;
    await this._col.insertOne(entry);
  }

  /**
   * Query the change log for a collection.
   * @param {string} collection
   * @param {{ since?: string|Date, limit?: number, session?: string }} [opts]
   * @returns {Promise<object[]>}
   */
  async query(collection, { since, limit, session } = {}) {
    const filter = { collection };
    if (since) filter.timestamp = { $gte: new Date(since) };
    if (session) filter.session = session;

    const opts = { sort: { timestamp: 1 } };
    if (limit) opts.limit = limit;

    const { docs } = await this._col.find(filter, opts);
    return docs;
  }

  /**
   * Restore a collection (or a single document) to its state at `timestamp`.
   * @param {string} collection
   * @param {string|Date} timestamp
   * @param {{ _id?: string }} [opts]
   * @returns {Promise<void>}
   */
  async restore(collection, timestamp, { _id } = {}) {
    const ts = new Date(timestamp);
    const col = this._db.useCollection(collection);

    const allEntries = await this.query(collection, {});
    const relevant = allEntries.filter(e => new Date(e.timestamp) <= ts);

    if (_id) {
      // Restore a single document
      const docEntries = relevant.filter(e => e.docId === _id);
      if (docEntries.length === 0) return;

      const last = docEntries[docEntries.length - 1];
      if (last.op === "delete") return; // was deleted at that point

      const existing = await col.findOne({ _id });
      if (existing) {
        // Overwrite with the snapshotted doc (excluding system timestamps)
        const { _id: id, createdAt, updatedAt, ...fields } = last.doc;
        await col.updateOne({ _id }, fields);
      } else {
        await col.insertOne({ ...last.doc });
      }
      return;
    }

    // Restore entire collection — replay all entries in order
    const state = new Map(); // docId → { doc, deleted }

    for (const entry of relevant) {
      if (entry.op === "insert" || entry.op === "update") {
        state.set(entry.docId, { doc: entry.doc, deleted: false });
      } else if (entry.op === "delete") {
        state.set(entry.docId, { doc: null, deleted: true });
      }
    }

    await col.deleteMany({});
    for (const [, { doc, deleted }] of state) {
      if (!deleted && doc) {
        await col.insertOne({ ...doc });
      }
    }
  }
}

module.exports = ChangeLog;
