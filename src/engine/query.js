/**
 * query.js  -  filter evaluation engine.
 *
 * matchesFilter(item, filter) → boolean
 * All conditions in filter use AND semantics (every key must match).
 *
 * Supported operators: $eq $ne $gt $gte $lt $lte $in $nin $regex $fn
 * Supported syntax: nested dot-notation, RegExp as direct value, function as filter
 *
 * SECURITY
 * --------
 * - `$fn` executes arbitrary JavaScript in the host process. Never pass
 *   user-controlled or AI-generated functions to `$fn`. MCP-sourced filters
 *   are sanitized by `sanitizeFilter()` in src/connectors/mcp/tools.js.
 * - `$regex` strings (not pre-compiled RegExp instances) are length-capped
 *   and rejected if they contain nested quantifiers that could cause
 *   catastrophic backtracking (ReDoS).
 */
import { resolveDotPath } from "./utils.js";
import { QueryError } from "./errors.js";

/** Default max length of a `$regex` string (pre-compiled RegExp instances bypass this). */
const DEFAULT_REGEX_MAX_LENGTH = 500;

/**
 * Validate and compile a `$regex` filter value. Pre-compiled RegExp instances
 * are trusted and returned as-is. Strings are length-capped and rejected if
 * they contain nested quantifiers like `(a+)+`, `(a|a)*`, `(x+){2,}`.
 * @param {string|RegExp} value
 * @param {number} [maxLength]
 * @returns {RegExp}
 */
function compileRegexFilter(value, maxLength = DEFAULT_REGEX_MAX_LENGTH) {
  if (value instanceof RegExp) return value;
  if (typeof value !== "string") {
    throw new QueryError(
      "ERR_SKALEX_QUERY_INVALID_REGEX",
      "$regex must be a string or RegExp instance",
      { operator: "$regex" }
    );
  }
  if (value.length > maxLength) {
    throw new QueryError(
      "ERR_SKALEX_QUERY_REGEX_TOO_LONG",
      `$regex pattern too long (${value.length} > ${maxLength}). Use a pre-compiled RegExp instance to bypass this cap.`,
      { operator: "$regex", length: value.length, maxLength }
    );
  }
  if (/\([^)]*[+*][^)]*\)[+*{]/.test(value)) {
    throw new QueryError(
      "ERR_SKALEX_QUERY_REGEX_REDOS",
      "$regex pattern rejected: nested quantifiers risk catastrophic backtracking (ReDoS)",
      { operator: "$regex" }
    );
  }
  try {
    return new RegExp(value);
  } catch {
    throw new QueryError(
      "ERR_SKALEX_QUERY_INVALID_REGEX",
      `Invalid $regex pattern: "${value}"`,
      { operator: "$regex" }
    );
  }
}

/**
 * Structural deep equality for plain values.
 * Handles: primitives, null, undefined, plain objects, arrays, Date, RegExp.
 * Circular references are out of scope (engine data is JSON-serializable).
 * @param {*} a
 * @param {*} b
 * @returns {boolean}
 */
function deepEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof RegExp && b instanceof RegExp) return a.source === b.source && a.flags === b.flags;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === "object") {
    if (Array.isArray(b)) return false;
    const keysA = Object.keys(a);
    if (keysA.length !== Object.keys(b).length) return false;
    for (const k of keysA) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!deepEqual(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

/**
 * @param {object} item
 * @param {object|function|{}} filter
 * @returns {boolean}
 */
function matchesFilter(item, filter) {
  // Function filter
  if (typeof filter === "function") return filter(item);

  // Null/undefined or empty filter  -  matches everything
  if (filter == null) return true;
  if (typeof filter === "object" && Object.keys(filter).length === 0) return true;

  // Logical operators - evaluated before field-level checks
  if ("$or" in filter) {
    const branches = filter.$or;
    if (!Array.isArray(branches)) throw new QueryError("ERR_SKALEX_QUERY_INVALID_OPERATOR", "$or must be an array of filters", { operator: "$or" });
    if (!branches.some(sub => matchesFilter(item, sub))) return false;
  }
  if ("$and" in filter) {
    const branches = filter.$and;
    if (!Array.isArray(branches)) throw new QueryError("ERR_SKALEX_QUERY_INVALID_OPERATOR", "$and must be an array of filters", { operator: "$and" });
    if (!branches.every(sub => matchesFilter(item, sub))) return false;
  }
  if ("$not" in filter) {
    if (matchesFilter(item, filter.$not)) return false;
  }

  // AND: every key must pass
  for (const key in filter) {
    if (key === "$or" || key === "$and" || key === "$not") continue;
    const filterValue = filter[key];

    // Resolve value (supports dot-notation)
    let itemValue;
    try {
      itemValue = resolveDotPath(item, key);
    } catch {
      return false;
    }

    if (filterValue instanceof RegExp) {
      if (!filterValue.test(String(itemValue))) return false;
    } else if (typeof filterValue === "object" && filterValue !== null) {
      if (Object.keys(filterValue).some(k => k.startsWith("$"))) {
        // Query operators
        if ("$eq" in filterValue && itemValue !== filterValue.$eq) return false;
        if ("$ne" in filterValue && itemValue === filterValue.$ne) return false;
        if ("$gt" in filterValue && !(itemValue > filterValue.$gt)) return false;
        if ("$lt" in filterValue && !(itemValue < filterValue.$lt)) return false;
        if ("$gte" in filterValue && !(itemValue >= filterValue.$gte)) return false;
        if ("$lte" in filterValue && !(itemValue <= filterValue.$lte)) return false;
        if ("$in" in filterValue && !filterValue.$in.includes(itemValue)) return false;
        if ("$nin" in filterValue && filterValue.$nin.includes(itemValue)) return false;
        if ("$regex" in filterValue) {
          const rx = compileRegexFilter(filterValue.$regex);
          if (!rx.test(String(itemValue))) return false;
        }
        if ("$fn" in filterValue && !filterValue.$fn(itemValue)) return false;
      } else {
        // Plain object value - structural equality
        if (!deepEqual(itemValue, filterValue)) return false;
      }
    } else {
      if (itemValue !== filterValue) return false;
    }
  }

  return true;
}

/**
 * Pre-sort filter keys for optimal evaluation order:
 *   1. Indexed exact-match fields (checked by caller  -  passed as Set)
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
  const logical = [];

  for (const key in filter) {
    if (key === "$or" || key === "$and" || key === "$not") {
      logical.push(key);
      continue;
    }
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
  for (const k of [...indexed, ...equality, ...range, ...expensive, ...logical]) {
    sorted[k] = filter[k];
  }
  return sorted;
}

export { matchesFilter, presortFilter };
