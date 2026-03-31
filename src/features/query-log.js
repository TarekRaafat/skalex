/**
 * query-log.js — slow query log for find / search operations.
 *
 * Queries whose duration exceeds `threshold` ms are recorded.
 * Call db.slowQueries(opts) to retrieve them.
 *
 * Entry shape:
 *   { collection, op, filter?, query?, duration, resultCount, timestamp }
 */
class QueryLog {
  /**
   * @param {{ threshold?: number, maxEntries?: number }} [opts]
   */
  constructor({ threshold = 100, maxEntries = 500 } = {}) {
    this._threshold  = threshold;
    this._maxEntries = maxEntries;
    this._entries    = [];
  }

  /**
   * Record a completed query.
   * @param {{ collection: string, op: string, filter?: object, query?: string, duration: number, resultCount: number }} entry
   */
  record({ collection, op, filter, query, duration, resultCount }) {
    if (duration < this._threshold) return;
    const entry = { collection, op, duration, resultCount, timestamp: new Date() };
    if (filter !== undefined) entry.filter = filter;
    if (query  !== undefined) entry.query  = query;
    this._entries.push(entry);
    // Ring buffer — drop oldest when full
    if (this._entries.length > this._maxEntries) this._entries.shift();
  }

  /**
   * Retrieve recorded slow queries.
   * @param {{ limit?: number, minDuration?: number, collection?: string }} [opts]
   * @returns {object[]}
   */
  entries({ limit, minDuration, collection } = {}) {
    let q = this._entries;
    if (collection)  q = q.filter(e => e.collection === collection);
    if (minDuration) q = q.filter(e => e.duration >= minDuration);
    if (limit)       q = q.slice(-limit);
    return q;
  }

  /** Number of recorded entries currently in the buffer. */
  get size() {
    return this._entries.length;
  }

  /** Clear all recorded entries. */
  clear() {
    this._entries = [];
  }
}

export default QueryLog;
