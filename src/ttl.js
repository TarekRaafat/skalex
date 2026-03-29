/**
 * ttl.js — document expiry engine.
 *
 * Documents with a `_expiresAt` field (Date) are auto-deleted
 * when the TTL sweep runs (on connect and optionally on a timer).
 *
 * TTL values accepted by parseTtl():
 *   number  → seconds
 *   "30m"   → 30 minutes
 *   "24h"   → 24 hours
 *   "7d"    → 7 days
 */

/**
 * Parse a TTL value into milliseconds.
 * @param {number|string} ttl
 * @returns {number} ms
 */
function parseTtl(ttl) {
  if (typeof ttl === "number") return ttl * 1000;
  if (typeof ttl !== "string") throw new Error(`Invalid TTL value: ${ttl}`);

  const match = ttl.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/);
  if (!match) throw new Error(`Invalid TTL format: "${ttl}". Use e.g. 300 (seconds), "30m", "24h", "7d"`);

  const val = parseFloat(match[1]);
  const unit = match[2];
  const multipliers = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return val * multipliers[unit];
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
  let i = data.length;

  while (i--) {
    const doc = data[i];
    if (doc._expiresAt && new Date(doc._expiresAt).getTime() <= now) {
      data.splice(i, 1);
      idIndex.delete(doc._id);
      if (removeFromIndexes) removeFromIndexes(doc);
      removed++;
    }
  }

  return removed;
}

module.exports = { parseTtl, computeExpiry, sweep };
