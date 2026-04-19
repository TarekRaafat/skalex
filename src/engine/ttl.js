/**
 * ttl.js  -  document expiry engine.
 *
 * Documents with a `_expiresAt` field (Date) are auto-deleted
 * when the TTL sweep runs (on connect and optionally on a timer).
 *
 * Supported TTL formats for the `ttl` option:
 *   number   → seconds (e.g. 300)
 *   "Nms"    → milliseconds (e.g. "500ms")
 *   "Ns"     → seconds     (e.g. "30s")
 *   "Nm"     → minutes     (e.g. "30m")
 *   "Nh"     → hours       (e.g. "24h")
 *   "Nd"     → days        (e.g. "7d")
 */
import { ValidationError } from "./errors.js";

/**
 * Parse a TTL value into milliseconds.
 * @param {number|string} ttl
 * @returns {number} ms
 */
function parseTtl(ttl) {
  if (typeof ttl === "number") {
    if (ttl <= 0) throw new ValidationError("ERR_SKALEX_VALIDATION_TTL", `TTL must be positive, got ${ttl}`, { ttl });
    return ttl * 1000;
  }
  if (typeof ttl !== "string") throw new ValidationError("ERR_SKALEX_VALIDATION_TTL", `Invalid TTL value: ${ttl}`, { ttl });

  const match = ttl.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/);
  if (!match) throw new ValidationError("ERR_SKALEX_VALIDATION_TTL_FORMAT", `Invalid TTL format: "${ttl}". Use e.g. 300 (seconds), "30m", "24h", "7d"`, { ttl });

  const val = parseFloat(match[1]);
  if (val <= 0) throw new ValidationError("ERR_SKALEX_VALIDATION_TTL", `TTL must be positive, got "${ttl}"`, { ttl });
  const unit = match[2];
  const multipliers = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const ms = val * multipliers[unit];
  if (!isFinite(ms)) throw new ValidationError("ERR_SKALEX_VALIDATION_TTL", `TTL value "${ttl}" is too large`, { ttl });
  return ms;
}

/**
 * Compute the expiry Date for a document given a TTL spec.
 * @param {number|string} ttl
 * @returns {Date}
 */
function computeExpiry(ttl) {
  return new Date(Date.now() + parseTtl(ttl));
}

/**
 * Sweep a collection"s data array and remove expired documents.
 * Mutates the array and the Map index in place.
 * @param {object[]} data
 * @param {Map} idIndex - _id → document map
 * @param {Function} removeFromIndexes - optional IndexEngine.remove callback
 * @returns {number} count of removed documents
 */
function sweep(data, idIndex, removeFromIndexes = null) {
  const now = Date.now();
  let removed = 0;

  // Single-pass filter-and-reassign. O(n) instead of O(n*k) for k expired docs
  // when using in-place splice on a backing array.
  const remaining = [];
  for (const doc of data) {
    if (doc._expiresAt && new Date(doc._expiresAt).getTime() <= now) {
      idIndex.delete(doc._id);
      if (removeFromIndexes) removeFromIndexes(doc);
      removed++;
    } else {
      remaining.push(doc);
    }
  }

  if (removed > 0) {
    data.length = 0;
    for (const doc of remaining) data.push(doc);
  }

  return removed;
}

/**
 * TtlScheduler - owns the periodic sweep timer lifecycle.
 *
 * Extracted from Skalex so the main class stays a thin facade.
 * The scheduler is stateless except for the interval handle.
 *
 * @param {object} opts
 * @param {number} opts.interval - Sweep interval in ms. 0 = no periodic sweep.
 * @param {object} opts.persistence - PersistenceManager reference.
 * @param {Function} opts.log - Debug logger (message) => void.
 */
class TtlScheduler {
  constructor({ interval, persistence, log }) {
    this._interval = interval ?? 0;
    this._persistence = persistence;
    this._log = log;
    this._timer = null;
  }

  /**
   * Sweep all collections once, removing expired TTL documents.
   * @param {object} collections - The live collection store map.
   */
  sweep(collections) {
    for (const name in collections) {
      const col = collections[name];
      const removed = sweep(col.data, col.index, col.fieldIndex ? doc => col.fieldIndex.remove(doc) : null);
      if (removed > 0) {
        this._persistence.markDirty(collections, name);
        this._log(`TTL sweep: removed ${removed} expired docs from "${name}"`);
      }
    }
  }

  /**
   * Start periodic sweeping if an interval was configured.
   * @param {object} collections - The live collection store map.
   */
  start(collections) {
    if (this._interval > 0 && !this._timer) {
      this._timer = setInterval(() => this.sweep(collections), this._interval);
      if (this._timer?.unref) this._timer.unref();
    }
  }

  /** Stop the periodic sweep timer. */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}

export { computeExpiry, sweep, TtlScheduler };
