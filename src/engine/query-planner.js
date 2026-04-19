import { matchesFilter } from "./query.js";

/**
 * Find the first document matching a filter.
 *
 * @param {object|Function|null} filter
 * @param {object[]} data - The collection data array.
 * @param {Map} idIndex - _id to doc Map.
 * @param {object|null} fieldIndex - IndexEngine or null.
 * @param {Function} isVisible - (doc, includeDeleted) => boolean.
 * @param {{ includeDeleted?: boolean }} [opts]
 * @returns {object|null}
 */
function findRaw(filter, data, idIndex, fieldIndex, isVisible, { includeDeleted = false } = {}) {
  if (typeof filter === "function") {
    for (const doc of data) {
      if (!isVisible(doc, includeDeleted)) continue;
      if (filter(doc)) return doc;
    }
    return null;
  }
  // Null, undefined, or empty filter: return the first visible doc.
  if (filter == null) {
    for (const doc of data) {
      if (isVisible(doc, includeDeleted)) return doc;
    }
    return null;
  }
  if (filter._id) {
    const item = idIndex.get(filter._id) || null;
    if (!item) return null;
    if (!isVisible(item, includeDeleted)) return null;
    if (Object.keys(filter).length > 1) {
      return matchesFilter(item, filter) ? item : null;
    }
    return item;
  }

  // Try O(1) indexed field lookup first
  if (fieldIndex) {
    for (const key in filter) {
      if (key === "$or" || key === "$and" || key === "$not") continue;
      const val = filter[key];
      if (typeof val !== "object" || val === null) {
        const candidates = fieldIndex._lookupIterable(key, val);
        if (candidates !== null) {
          for (const doc of candidates) {
            if (!isVisible(doc, includeDeleted)) continue;
            if (matchesFilter(doc, filter)) return doc;
          }
          return null;
        }
      }
    }
  }

  for (const doc of data) {
    if (!isVisible(doc, includeDeleted)) continue;
    if (matchesFilter(doc, filter)) return doc;
  }
  return null;
}

/**
 * Find all documents matching a filter.
 *
 * @param {object|Function} filter
 * @param {object[]} data
 * @param {Map} idIndex
 * @param {object|null} fieldIndex
 * @param {Function} isVisible
 * @param {{ includeDeleted?: boolean }} [opts]
 * @returns {object[]}
 */
function findAllRaw(filter, data, idIndex, fieldIndex, isVisible, { includeDeleted = false } = {}) {
  if (filter && typeof filter !== "function" && filter._id) {
    const item = idIndex.get(filter._id);
    if (!item) return [];
    if (!isVisible(item, includeDeleted)) return [];
    return matchesFilter(item, filter) ? [item] : [];
  }
  const results = [];
  for (const doc of getCandidates(filter, data, fieldIndex)) {
    if (!isVisible(doc, includeDeleted)) continue;
    if (matchesFilter(doc, filter)) results.push(doc);
  }
  return results;
}

/**
 * Get the candidate set for a filter, using indexes when available.
 *
 * @param {object} filter
 * @param {object[]} data
 * @param {object|null} fieldIndex
 * @returns {Iterable<object>}
 */
function getCandidates(filter, data, fieldIndex) {
  if (!fieldIndex) return data;

  // Try compound index first - matches more fields in one lookup
  if (fieldIndex._compoundIndexes.size > 0) {
    const eqFields = {};
    for (const key in filter) {
      if (key === "$or" || key === "$and" || key === "$not") continue;
      const val = filter[key];
      if (typeof val !== "object" || val === null) eqFields[key] = val;
    }
    if (Object.keys(eqFields).length >= 2) {
      const candidates = fieldIndex.lookupCompound(eqFields);
      if (candidates !== null) return candidates;
    }
  }

  // Fall back to single-field index
  for (const key in filter) {
    if (key === "$or" || key === "$and" || key === "$not") continue;
    const val = filter[key];
    if (typeof val !== "object" || val === null) {
      const candidates = fieldIndex._lookupIterable(key, val);
      if (candidates !== null) return candidates;
    }
  }
  return data;
}

/**
 * Find the array index of the first doc matching a filter.
 *
 * @param {object} filter
 * @param {object[]} data
 * @returns {number} -1 if not found.
 */
function findIndex(filter, data) {
  for (let i = 0; i < data.length; i++) {
    if (matchesFilter(data[i], filter)) return i;
  }
  return -1;
}

export { findRaw, findAllRaw, getCandidates, findIndex };
