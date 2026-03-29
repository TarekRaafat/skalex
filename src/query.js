/**
 * query.js — filter evaluation engine.
 *
 * matchesFilter(item, filter) → boolean
 * All conditions in filter use AND semantics (every key must match).
 *
 * Supported operators: $eq $ne $gt $gte $lt $lte $in $nin $regex $fn
 * Supported syntax: nested dot-notation, RegExp as direct value, function as filter
 */

/**
 * @param {object} item
 * @param {object|function|{}} filter
 * @returns {boolean}
 */
function matchesFilter(item, filter) {
  // Function filter
  if (typeof filter === "function") return filter(item);

  // Empty filter — matches everything
  if (filter instanceof Object && Object.keys(filter).length === 0) return true;

  // AND: every key must pass
  for (const key in filter) {
    const filterValue = filter[key];

    // Resolve value (supports dot-notation)
    let itemValue;
    try {
      const parts = key.split(".");
      itemValue = parts.length > 1
        ? parts.reduce((obj, k) => (obj != null ? obj[k] : undefined), item)
        : item[key];
    } catch {
      return false;
    }

    if (filterValue instanceof RegExp) {
      if (!filterValue.test(String(itemValue))) return false;
    } else if (typeof filterValue === "object" && filterValue !== null) {
      // Query operators
      if ("$eq"    in filterValue && itemValue !== filterValue.$eq)               return false;
      if ("$ne"    in filterValue && itemValue === filterValue.$ne)               return false;
      if ("$gt"    in filterValue && !(itemValue > filterValue.$gt))              return false;
      if ("$lt"    in filterValue && !(itemValue < filterValue.$lt))              return false;
      if ("$gte"   in filterValue && !(itemValue >= filterValue.$gte))            return false;
      if ("$lte"   in filterValue && !(itemValue <= filterValue.$lte))            return false;
      if ("$in"    in filterValue && !filterValue.$in.includes(itemValue))        return false;
      if ("$nin"   in filterValue && filterValue.$nin.includes(itemValue))        return false;
      if ("$regex" in filterValue && !filterValue.$regex.test(String(itemValue))) return false;
      if ("$fn"    in filterValue && !filterValue.$fn(itemValue))                 return false;
    } else {
      if (itemValue !== filterValue) return false;
    }
  }

  return true;
}

/**
 * Pre-sort filter keys for optimal evaluation order:
 *   1. Indexed exact-match fields (checked by caller — passed as Set)
 *   2. Plain equality checks ($eq or raw value)
 *   3. Range operators ($gt, $gte, $lt, $lte, $ne, $in, $nin)
 *   4. Regex / function ($regex, $fn, RegExp value, function filter)
 *
 * Returns a new filter object with keys in the optimal order.
 * @param {object} filter
 * @param {Set<string>} [indexedFields]
 * @returns {object}
 */
function presortFilter(filter, indexedFields = new Set()) {
  if (typeof filter !== "object" || filter === null || typeof filter === "function") {
    return filter;
  }

  const indexed = [];
  const equality = [];
  const range = [];
  const expensive = [];

  for (const key in filter) {
    const val = filter[key];
    if (indexedFields.has(key)) {
      indexed.push(key);
    } else if (
      val instanceof RegExp ||
      (typeof val === "object" && val !== null && ("$regex" in val || "$fn" in val)) ||
      typeof val === "function"
    ) {
      expensive.push(key);
    } else if (typeof val === "object" && val !== null && ("$gt" in val || "$lt" in val || "$gte" in val || "$lte" in val || "$ne" in val || "$in" in val || "$nin" in val)) {
      range.push(key);
    } else {
      equality.push(key);
    }
  }

  const sorted = {};
  for (const k of [...indexed, ...equality, ...range, ...expensive]) {
    sorted[k] = filter[k];
  }
  return sorted;
}

module.exports = { matchesFilter, presortFilter };
