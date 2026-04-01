/**
 * aggregation.js  -  count / sum / avg / groupBy helpers.
 *
 * These are pure functions operating on a filtered doc array returned by
 * _findAllRaw(). They are called by the Collection methods of the same name.
 */
import { resolveDotPath } from "../engine/utils.js";

/**
 * Count documents matching a filter.
 * @param {object[]} docs
 * @returns {number}
 */
function count(docs) {
  return docs.length;
}

/**
 * Sum a numeric field across documents.
 * Non-numeric values are skipped (treated as 0 contribution).
 * @param {object[]} docs
 * @param {string} field
 * @returns {number}
 */
function sum(docs, field) {
  let total = 0;
  for (const doc of docs) {
    const val = resolveDotPath(doc, field);
    if (typeof val === "number" && !isNaN(val)) total += val;
  }
  return total;
}

/**
 * Average a numeric field across documents.
 * Returns null when no numeric values are found.
 * @param {object[]} docs
 * @param {string} field
 * @returns {number|null}
 */
function avg(docs, field) {
  let total = 0;
  let n = 0;
  for (const doc of docs) {
    const val = resolveDotPath(doc, field);
    if (typeof val === "number" && !isNaN(val)) { total += val; n++; }
  }
  return n === 0 ? null : total / n;
}

/**
 * Group documents by a field value.
 * Returns a plain object mapping value → docs[].
 * @param {object[]} docs
 * @param {string} field
 * @returns {Record<string, object[]>}
 */
function groupBy(docs, field) {
  const groups = Object.create(null);
  for (const doc of docs) {
    const key = String(resolveDotPath(doc, field) ?? "__null__");
    if (!groups[key]) groups[key] = [];
    groups[key].push(doc);
  }
  return groups;
}

export { count, sum, avg, groupBy };
