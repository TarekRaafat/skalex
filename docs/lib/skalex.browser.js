var nodeCrypto = {};

/**
 * Generates a unique ID.
 * @returns {string} The unique ID.
 */
function generateUniqueId() {
  const timestamp = Date.now().toString(16);

  let random;
  try {
    random = nodeCrypto.randomBytes(8).toString("hex");
  } catch {
    const arr = new Uint8Array(8);
    crypto.getRandomValues(arr);
    random = Array.from(arr).map(b => b.toString(16).padStart(2, "0")).join("");
  }

  return `${timestamp}${random}`;
}

/**
 * Logs a message or Error to the console.
 * @param {string|Error} error - Message string or Error object to log.
 * @param {"error"|undefined} type - Pass "error" to route to console.error.
 */
function logger(error, type) {
  const msg = error instanceof Error ? error.message : error;

  if (type === "error") {
    console.error(msg);
  } else {
    console.log(msg);
  }
}

/**
 * Resolve a dot-notation field path on an object.
 * Returns undefined if any intermediate segment is null/undefined.
 * @param {object} obj
 * @param {string} path  - e.g. "address.city"
 * @returns {unknown}
 */
const _FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function resolveDotPath(obj, path) {
  if (!path.includes(".")) {
    if (_FORBIDDEN_KEYS.has(path)) return undefined;
    return obj[path];
  }
  let cur = obj;
  for (const p of path.split(".")) {
    if (_FORBIDDEN_KEYS.has(p)) return undefined;
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

/**
 * errors.js  -  typed error hierarchy for the Skalex engine.
 *
 * Every engine throw uses a typed error with a stable code so consumers
 * can handle errors programmatically without parsing message strings.
 *
 * Code convention:  ERR_SKALEX_<SUBSYSTEM>_<SPECIFIC>
 */

/**
 * Base error for all Skalex engine errors.
 * @extends Error
 */
class SkalexError extends Error {
  /**
   * @param {string} code    - Stable error code (e.g. "ERR_SKALEX_VALIDATION_REQUIRED").
   * @param {string} message - Human-readable description.
   * @param {object} [details] - Structured context for programmatic consumers.
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.details = details;
  }
}

/** Schema parsing or document validation failure. */
class ValidationError extends SkalexError { }

/** Insert or update violates a unique field constraint. */
class UniqueConstraintError extends SkalexError { }

/** Transaction timeout, abort, or rollback failure. */
class TransactionError extends SkalexError { }

/** Load, save, serialization, or flush failure. */
class PersistenceError extends SkalexError { }

/** Storage or AI adapter misconfiguration or missing dependency. */
class AdapterError extends SkalexError { }

/** Query filter, operator, or execution failure. */
class QueryError extends SkalexError { }

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
 *
 * Implementation note: relies on ES2015+ object property insertion-order
 * iteration guarantee (non-integer string keys iterate in creation order,
 * specified in ECMA-262 section 13.7.5.15). This is supported by all target
 * runtimes (Node 18+, modern browsers, Bun, Deno). The returned filter's
 * key order determines matchesFilter's evaluation order, so indexed fields
 * are checked first for early rejection.
 *
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

/**
 * validator.js  -  lightweight schema validation, zero dependencies.
 *
 * Schema definition:
 *   { field: "type" }
 *   { field: { type: "string", required: true, unique: true, enum: [...] } }
 *
 * Supported types: "string", "number", "boolean", "object", "array", "date", "any"
 */


const SUPPORTED_TYPES = new Set(["string", "number", "boolean", "object", "array", "date", "any"]);

/**
 * Determine the runtime type of a value using the schema type vocabulary.
 * @param {*} val
 * @returns {string}
 */
function typeOf(val) {
  if (Array.isArray(val)) return "array";
  if (val instanceof Date) return "date";
  return typeof val;
}

/**
 * Parse a raw schema definition into a normalised internal form.
 * @param {object} schema
 * @returns {{ fields: Map<string, FieldDef>, uniqueFields: string[] }}
 */
function parseSchema(schema) {
  const fields = new Map();
  const uniqueFields = [];

  for (const [key, def] of Object.entries(schema)) {
    let fieldDef;

    if (typeof def === "string") {
      if (!SUPPORTED_TYPES.has(def)) {
        throw new ValidationError("ERR_SKALEX_VALIDATION_UNKNOWN_TYPE", `Unknown schema type "${def}" for field "${key}"`, { field: key, type: def });
      }
      fieldDef = { type: def, required: false, unique: false };
    } else if (typeof def === "object" && def !== null) {
      const { type = "any", required = false, unique = false, enum: enumVals } = def;
      if (!SUPPORTED_TYPES.has(type)) {
        throw new ValidationError("ERR_SKALEX_VALIDATION_UNKNOWN_TYPE", `Unknown schema type "${type}" for field "${key}"`, { field: key, type });
      }
      fieldDef = { type, required, unique, enum: enumVals };
      if (unique) uniqueFields.push(key);
    } else {
      throw new ValidationError("ERR_SKALEX_VALIDATION_INVALID_SCHEMA", `Invalid schema definition for field "${key}"`, { field: key });
    }

    fields.set(key, fieldDef);
  }

  return { fields, uniqueFields };
}

/**
 * Validate a document against a parsed schema.
 * Returns an array of error strings (empty = valid).
 * @param {object} doc
 * @param {Map<string, object>} fields
 * @param {boolean} [strict=false] - Reject unknown fields not declared in the schema.
 * @returns {string[]}
 */
function validateDoc(doc, fields, strict = false) {
  const errors = [];

  for (const [key, def] of fields) {
    const val = doc[key];
    const missing = val === undefined || val === null;

    if (def.required && missing) {
      errors.push(`Field "${key}" is required`);
      continue;
    }

    if (missing) continue;

    if (def.type !== "any") {
      const actualType = typeOf(val);
      if (actualType !== def.type) {
        errors.push(`Field "${key}" must be of type "${def.type}", got "${actualType}"`);
      }
    }

    if (def.enum && !def.enum.includes(val)) {
      errors.push(`Field "${key}" must be one of [${def.enum.map(v => JSON.stringify(v)).join(", ")}], got ${JSON.stringify(val)}`);
    }
  }

  if (strict) {
    for (const key of Object.keys(doc)) {
      if (!key.startsWith("_") && !fields.has(key)) {
        errors.push(`Unknown field "${key}" (strict mode)`);
      }
    }
  }

  return errors;
}

/**
 * Strip fields that are unknown to the schema or fail type/enum validation.
 * Preserves all internal fields (prefixed with "_").
 * @param {object} doc
 * @param {Map<string, object>} fields
 * @returns {object}
 */
function stripInvalidFields(doc, fields) {
  const out = {};
  for (const [key, val] of Object.entries(doc)) {
    if (key.startsWith("_")) { out[key] = val; continue; }
    if (!fields.has(key)) continue;
    const def = fields.get(key);
    if (def.type !== "any") {
      const actualType = typeOf(val);
      if (actualType !== def.type) continue;
    }
    if (def.enum && !def.enum.includes(val)) continue;
    out[key] = val;
  }
  return out;
}

/**
 * Infer a simple schema from a sample document.
 * @param {object} doc
 * @returns {object}
 */
function inferSchema(doc) {
  const schema = {};
  for (const [key, val] of Object.entries(doc)) {
    if (key.startsWith("_")) continue; // skip internal fields
    const t = typeOf(val);
    schema[key] = SUPPORTED_TYPES.has(t) ? t : "any";
  }
  return schema;
}

/**
 * vector.js  -  cosine similarity and vector utilities.
 *
 * Vectors are stored inline on documents as `_vector: number[]`.
 * They are stripped from all query results automatically.
 */


/**
 * Compute cosine similarity between two numeric vectors.
 * Returns a value in [-1, 1]; 1 = identical direction, 0 = orthogonal.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
function cosineSimilarity(a, b) {
  if (a.length !== b.length) {
    throw new QueryError("ERR_SKALEX_QUERY_VECTOR_MISMATCH", `Vector dimension mismatch: ${a.length} vs ${b.length}`, { expected: a.length, got: b.length });
  }

  let dot = 0, magA = 0, magB = 0;

  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  const denom = Math.sqrt(magA * magB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Return a shallow copy of a document with `_vector` removed.
 * Used by all query methods so callers never see the raw vector.
 * @param {object} doc
 * @returns {object}
 */
function stripVector(doc) {
  if (!("_vector" in doc)) return { ...doc };
  const { _vector, ...rest } = doc;
  return rest;
}

/**
 * aggregation.js  -  count / sum / avg / groupBy helpers.
 *
 * These are pure functions operating on a filtered doc array returned by
 * _findAllRaw(). They are called by the Collection methods of the same name.
 */

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

/**
 * pipeline.js  -  MutationPipeline for Skalex collections.
 *
 * Extracts the shared pre/post mutation lifecycle so each CRUD method
 * only defines its operation-specific logic.
 *
 * Shared lifecycle:
 *   ensureConnected → txSnapshot → beforePlugin → [mutation] →
 *   markDirty → save → changelog → sessionStats → event → afterPlugin
 */

class MutationPipeline {
  /**
   * @param {import("./collection.js").default} collection
   */
  constructor(collection) {
    this._col = collection;
  }

  /** @returns {CollectionContext} */
  get _ctx() { return this._col._ctx; }

  /**
   * Execute a mutation with the full lifecycle.
   *
   * Event ordering contract
   * -----------------------
   * Watch events are emitted **before** the after-hook runs. This is
   * intentional: it keeps observers on the synchronous path of the mutation
   * and preserves strict per-collection delivery order. A consequence is
   * that observers may see a mutation event whose corresponding after-hook
   * subsequently throws - the mutation itself is already committed.
   *
   * Event dispatch is synchronous. A slow watch listener blocks the
   * mutation pipeline. Listeners should hand work off to a queue if they
   * need to do anything non-trivial.
   *
   * @param {object} opts
   * @param {string}   opts.op          - One of the `Ops` values from src/engine/constants.js.
   * @param {string}   opts.beforeHook  - One of the `Hooks` values from src/engine/constants.js (e.g. `Hooks.BEFORE_INSERT`).
   * @param {string}   opts.afterHook   - One of the `Hooks` values from src/engine/constants.js (e.g. `Hooks.AFTER_INSERT`).
   * @param {object}   opts.hookPayload - Data passed to before hook.
   * @param {Function} opts.mutate      - async (assertTxAlive) => { docs, prevDocs }
   * @param {Function} [opts.afterHookPayload] - (docs) => payload for after hook.
   * @param {boolean|undefined} opts.save
   * @param {string|undefined}  opts.session
   * @returns {Promise<{ docs: object[], prevDocs: (object|null)[] }>}
   */
  async execute({ op, beforeHook, afterHook, hookPayload, mutate, afterHookPayload, save, session }) {
    const ctx = this._ctx;

    await ctx.ensureConnected();

    // Block non-transactional writes to collections locked by an active tx.
    // Must run BEFORE _txSnapshotIfNeeded() because the snapshot would add
    // this collection to touchedCollections even for a non-tx write (since
    // _activeTxId is set on the shared Collection singleton).
    // The tx proxy wraps each method call to increment _txProxyCallDepth for
    // the duration of the call (depth counter, not boolean, to handle
    // concurrent unawaited calls on the same Collection instance). Reads are
    // unaffected (they don't go through the pipeline).
    const txm = ctx.txManager;
    if (!(this._col._txProxyCallDepth > 0) && txm.isCollectionLocked(this._col.name)) {
      throw new TransactionError(
        "ERR_SKALEX_TX_COLLECTION_LOCKED",
        `Collection "${this._col.name}" is locked by an active transaction. ` +
        `Non-transactional writes are blocked until the transaction commits or rolls back.`
      );
    }

    this._col._txSnapshotIfNeeded();

    // Determine if this mutation is part of the active transaction.
    // Collections obtained through the tx proxy have _activeTxId stamped.
    // Only those writes participate in snapshot/rollback.
    const isTxWrite = txm.active && this._col._activeTxId === txm.context?.id;

    // Detect stale continuations from aborted transactions.
    // Two sources of tx affinity:
    //   1. entryTxId: the tx active when this execute() call started
    //   2. _createdInTxId: the tx active when this Collection instance was created
    // Either being in the aborted set means this mutation must be rejected.
    const entryTxId = isTxWrite ? txm.context.id : null;
    const collTxId = this._col._createdInTxId;

    /** Guard callable passed into mutate() - must be called immediately
     *  before the first in-memory state change (push to _data, index.set, etc.). */
    const assertTxAlive = () => {
      if (entryTxId !== null && txm._abortedIds.has(entryTxId)) {
        throw new TransactionError(
          "ERR_SKALEX_TX_ABORTED",
          `Transaction ${entryTxId} was aborted. No further mutations allowed.`
        );
      }
      if (collTxId !== null && txm._abortedIds.has(collTxId)) {
        throw new TransactionError(
          "ERR_SKALEX_TX_ABORTED",
          `Transaction ${collTxId} was aborted. Collection obtained inside that transaction cannot be used for further mutations.`
        );
      }
    };

    // Eager check before any work (only for tx-affiliated writes)
    if (isTxWrite || collTxId !== null) assertTxAlive();

    if (beforeHook) await ctx.plugins.run(beforeHook, hookPayload);

    const { docs, prevDocs = [] } = await mutate(assertTxAlive);

    // Mark collection dirty so saveDirty() knows it needs persistence
    ctx.persistence.markDirty(ctx.collections, this._col.name);

    await this._col._saveIfNeeded(save);

    // Changelog
    if (this._col._changelogEnabled) {
      for (let i = 0; i < docs.length; i++) {
        await ctx.logChange(op, this._col.name, docs[i], prevDocs[i] ?? null, session || null);
      }
    }

    // Session stats - deferred for tx writes so rolled-back writes don't count.
    // Non-tx writes record immediately even during an active transaction.
    if (!isTxWrite || !txm.defer(() => ctx.sessionStats.recordWrite(session))) {
      ctx.sessionStats.recordWrite(session);
    }

    // Events
    for (const doc of docs) {
      ctx.emitEvent(this._col.name, { op, collection: this._col.name, doc: stripVector(doc) });
    }

    // After hook - fire per-doc for insert, single call for update/delete.
    // All hook payloads receive vector-stripped docs for consistency, so
    // plugins don't have to handle _vector presence vs absence per hook type.
    if (afterHook) {
      if (afterHookPayload) {
        const stripped = docs.map(stripVector);
        await ctx.runAfterHook(afterHook, afterHookPayload(stripped));
      } else {
        for (const doc of docs) {
          await ctx.runAfterHook(afterHook, { collection: this._col.name, doc: stripVector(doc) });
        }
      }
    }

    return { docs, prevDocs };
  }

  /**
   * Batch mutation variant used by operations that resolve to a mix of
   * inserts and updates (currently `upsertMany`). Amortizes per-doc pipeline
   * overhead into a single pass:
   *
   *   - `ensureConnected`, lock check, `_txSnapshotIfNeeded`, `assertTxAlive`
   *     eager check, `markDirty`, `_saveIfNeeded`, and `sessionStats.recordWrite`
   *     all run once for the whole batch.
   *
   * Preserves per-document correctness where it matters to observers:
   *
   *   - Changelog entries are emitted per document, using the per-doc `op`
   *     string in `result.ops` when present, otherwise falling back to the
   *     batch-level `op`.
   *   - Watch events fire per document with the same op-per-doc semantics.
   *
   * Plugin hooks are NOT dispatched here. The caller is responsible for
   * firing `beforeInsert` / `beforeUpdate` inside `mutateBatch` (before the
   * in-memory state change) and `afterInsert` / `afterUpdate` after the
   * returned promise resolves, so upsertMany preserves the existing per-doc
   * hook contract that callers already rely on.
   *
   * @param {object} opts
   * @param {string}   opts.op           - Default op for changelog/events.
   * @param {Function} opts.mutateBatch  - async (assertTxAlive) => { docs: object[], prevDocs?: (object|null)[], ops?: string[] }
   * @param {boolean|undefined} opts.save
   * @param {string|undefined}  opts.session
   * @returns {Promise<{ docs: object[], prevDocs: (object|null)[], ops: string[] }>}
   */
  async executeBatch({ op, mutateBatch, save, session }) {
    const ctx = this._ctx;

    await ctx.ensureConnected();

    const txm = ctx.txManager;
    if (!(this._col._txProxyCallDepth > 0) && txm.isCollectionLocked(this._col.name)) {
      throw new TransactionError(
        "ERR_SKALEX_TX_COLLECTION_LOCKED",
        `Collection "${this._col.name}" is locked by an active transaction. ` +
        `Non-transactional writes are blocked until the transaction commits or rolls back.`
      );
    }

    this._col._txSnapshotIfNeeded();

    const isTxWrite = txm.active && this._col._activeTxId === txm.context?.id;
    const entryTxId = isTxWrite ? txm.context.id : null;
    const collTxId = this._col._createdInTxId;

    const assertTxAlive = () => {
      if (entryTxId !== null && txm._abortedIds.has(entryTxId)) {
        throw new TransactionError(
          "ERR_SKALEX_TX_ABORTED",
          `Transaction ${entryTxId} was aborted. No further mutations allowed.`
        );
      }
      if (collTxId !== null && txm._abortedIds.has(collTxId)) {
        throw new TransactionError(
          "ERR_SKALEX_TX_ABORTED",
          `Transaction ${collTxId} was aborted. Collection obtained inside that transaction cannot be used for further mutations.`
        );
      }
    };

    if (isTxWrite || collTxId !== null) assertTxAlive();

    const result = await mutateBatch(assertTxAlive);
    const docs = Array.isArray(result?.docs) ? result.docs : [];
    const prevDocs = Array.isArray(result?.prevDocs) ? result.prevDocs : [];
    const ops = Array.isArray(result?.ops) ? result.ops : [];

    if (docs.length === 0) {
      return { docs, prevDocs, ops };
    }

    ctx.persistence.markDirty(ctx.collections, this._col.name);
    await this._col._saveIfNeeded(save);

    if (this._col._changelogEnabled) {
      for (let i = 0; i < docs.length; i++) {
        await ctx.logChange(ops[i] || op, this._col.name, docs[i], prevDocs[i] ?? null, session || null);
      }
    }

    if (!isTxWrite || !txm.defer(() => ctx.sessionStats.recordWrite(session))) {
      ctx.sessionStats.recordWrite(session);
    }

    for (let i = 0; i < docs.length; i++) {
      ctx.emitEvent(this._col.name, {
        op: ops[i] || op,
        collection: this._col.name,
        doc: stripVector(docs[i]),
      });
    }

    return { docs, prevDocs, ops };
  }
}

/**
 * constants.js  -  Shared engine constants.
 *
 * Operation and hook names used across the mutation pipeline, changelog,
 * events, and plugin APIs. Centralised here so there is exactly one source
 * of truth and typos become compile-time surface rather than silent bugs.
 */

const Ops = Object.freeze({
  INSERT: "insert",
  UPDATE: "update",
  DELETE: "delete",
  RESTORE: "restore",
});

const Hooks = Object.freeze({
  BEFORE_INSERT: "beforeInsert",
  AFTER_INSERT:  "afterInsert",
  BEFORE_UPDATE: "beforeUpdate",
  AFTER_UPDATE:  "afterUpdate",
  BEFORE_DELETE: "beforeDelete",
  AFTER_DELETE:  "afterDelete",
  BEFORE_FIND:   "beforeFind",
  AFTER_FIND:    "afterFind",
  BEFORE_SEARCH: "beforeSearch",
  AFTER_SEARCH:  "afterSearch",
  AFTER_RESTORE: "afterRestore",
});

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

/**
 * Build a new document from a raw item: assign _id/timestamps, apply TTL,
 * embed vector, and set initial _version when versioning is on.
 *
 * @param {object} item - Raw user-supplied document.
 * @param {object} opts
 * @param {number|string} [opts.ttl] - Per-doc TTL override.
 * @param {string|Function} [opts.embed] - Per-doc embed override.
 * @param {number|string} [opts.defaultTtl] - Collection-level TTL default.
 * @param {string|Function} [opts.defaultEmbed] - Collection-level embed default.
 * @param {boolean} [opts.versioning] - Whether versioning is enabled.
 * @param {Function|null} [opts.idGenerator] - Custom ID generator or null.
 * @param {Function} [opts.embedFn] - async (text) => number[].
 * @returns {Promise<object>}
 */
async function buildDoc(item, { ttl, embed, defaultTtl, defaultEmbed, versioning, idGenerator, embedFn } = {}) {
  const newItem = {
    ...item,
    _id: item._id ?? (idGenerator ?? generateUniqueId)(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const resolvedTtl = ttl ?? defaultTtl;
  if (resolvedTtl) newItem._expiresAt = computeExpiry(resolvedTtl);

  const resolvedEmbed = embed ?? defaultEmbed;
  if (resolvedEmbed) {
    if (typeof embedFn !== "function") {
      throw new AdapterError(
        "ERR_SKALEX_ADAPTER_EMBEDDING_REQUIRED",
        "Document embedding requires an AI adapter. Pass { ai: { provider, apiKey } } to the Skalex constructor.",
      );
    }
    const text = typeof resolvedEmbed === "function" ? resolvedEmbed(newItem) : newItem[resolvedEmbed];
    newItem._vector = await embedFn(String(text));
  }

  if (versioning) newItem._version = 1;

  return newItem;
}

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

/**
 * Semantic similarity search - embed a query string and rank all candidate
 * documents by cosine similarity.
 *
 * @param {string} query - Natural-language query text.
 * @param {object[]} candidates - Pre-filtered document list.
 * @param {Function} embedFn - async (text) => number[].
 * @param {{ limit?: number, minScore?: number }} opts
 * @returns {Promise<{ docs: object[], scores: number[] }>}
 */
async function vectorSearch(query, candidates, embedFn, { limit = 10, minScore = 0 } = {}) {
  const queryVector = await embedFn(query);

  const scored = [];
  for (const doc of candidates) {
    if (!doc._vector) continue;
    const score = cosineSimilarity(queryVector, doc._vector);
    if (score >= minScore) scored.push({ doc, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, limit);

  return {
    docs: top.map(r => stripVector(r.doc)),
    scores: top.map(r => r.score),
  };
}

/**
 * Find the nearest neighbours to an existing document by its vector.
 *
 * @param {number[]} sourceVector - The source document's vector.
 * @param {string} sourceId - The source document's _id (excluded from results).
 * @param {object[]} data - Full data array.
 * @param {{ limit?: number, minScore?: number }} opts
 * @returns {{ docs: object[], scores: number[] }}
 */
function similarByVector(sourceVector, sourceId, data, { limit = 10, minScore = 0 } = {}) {
  const scored = [];
  for (const doc of data) {
    if (doc._id === sourceId || !doc._vector) continue;
    const score = cosineSimilarity(sourceVector, doc._vector);
    if (score >= minScore) scored.push({ doc, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, limit);

  return {
    docs: top.map(r => stripVector(r.doc)),
    scores: top.map(r => r.score),
  };
}

/**
 * Export filtered collection data to a file via the storage adapter.
 *
 * @param {object[]} data - The collection's data array.
 * @param {string} collectionName
 * @param {object} filter - Query filter.
 * @param {object} opts
 * @param {string} [opts.dir] - Export directory override.
 * @param {string} [opts.name] - File name override.
 * @param {"json"|"csv"} [opts.format="json"]
 * @param {object} ctx - Collection context with fs, dataDirectory, logger.
 * @returns {Promise<void>}
 */
async function exportData(data, collectionName, filter, { dir, name, format = "json" } = {}, ctx) {
  try {
    const filteredData = data.filter(item => matchesFilter(item, filter));

    if (filteredData.length === 0) {
      throw new QueryError("ERR_SKALEX_QUERY_EXPORT_EMPTY", `export(): no documents matched the filter in "${collectionName}"`, { collection: collectionName });
    }

    let content;
    if (format === "json") {
      content = JSON.stringify(filteredData, null, 2);
    } else {
      const escapeCsv = (v) => {
        if (v == null) return "";
        const s = (typeof v === "object") ? JSON.stringify(v) : String(v);
        // Escape if value contains comma, quote, or newline (RFC 4180)
        return (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r"))
          ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const header = Object.keys(filteredData[0]).map(escapeCsv).join(",");
      const rows = filteredData.map(item =>
        Object.values(item).map(escapeCsv).join(",")
      );
      content = [header, ...rows].join("\n");
    }

    if (typeof ctx.fs.writeRaw !== "function") {
      throw new AdapterError(
        "ERR_SKALEX_ADAPTER_NO_RAW_WRITE",
        `export() requires a file-system adapter (FsAdapter). The current adapter does not support raw file writes.`
      );
    }

    const exportDir = dir || `${ctx.dataDirectory}/exports`;
    const fileName = `${name || collectionName}.${format}`;
    const filePath = ctx.fs.join(exportDir, fileName);

    ctx.fs.ensureDir(exportDir);
    await ctx.fs.writeRaw(filePath, content);
  } catch (error) {
    ctx.logger(`Error exporting "${collectionName}": ${error.message}`, "error");
    throw error;
  }
}

/**
 * datastore.js - abstraction between Collection and raw data storage.
 *
 * InMemoryDataStore wraps the existing `data` array and `index` Map on the
 * collection store object by reference. Persistence and transactions continue
 * reading `col.data` / `col.index` directly - the DataStore is an internal
 * seam for Collection's code so a future disk-backed engine can swap in
 * without rewriting every CRUD method.
 */

class InMemoryDataStore {
  /**
   * @param {object} store - The collection store object from CollectionRegistry.
   *   Must have `data` (array) and `index` (Map<string, object>) properties.
   */
  constructor(store) {
    this._store = store;
  }

  /** @returns {object[]} */
  get data() { return this._store.data; }

  /** @returns {Map<string, object>} */
  get index() { return this._store.index; }

  /** Number of documents. */
  count() { return this._store.data.length; }

  /** Look up a document by _id. @returns {object|null} */
  getById(id) { return this._store.index.get(id) || null; }

  /** Check if a document with the given _id exists. @returns {boolean} */
  has(id) { return this._store.index.has(id); }

  /** Append documents to the end. */
  push(...docs) {
    this._store.data.push(...docs);
    for (const doc of docs) this._store.index.set(doc._id, doc);
  }

  /** Replace a document at a known position. */
  replaceAt(idx, doc) {
    this._store.data[idx] = doc;
    this._store.index.set(doc._id, doc);
  }

  /** Set a doc in the index without changing position (for restore/update). */
  setInIndex(id, doc) {
    this._store.index.set(id, doc);
  }

  /** Remove a single document by position. @returns {object} */
  spliceAt(idx) {
    const [doc] = this._store.data.splice(idx, 1);
    this._store.index.delete(doc._id);
    return doc;
  }

  /** Remove a range from the front. @returns {object[]} */
  spliceRange(start, count) {
    const removed = this._store.data.splice(start, count);
    for (const doc of removed) this._store.index.delete(doc._id);
    return removed;
  }

  /** Delete a doc from the index only (used by soft-delete bulk path). */
  deleteFromIndex(id) {
    this._store.index.delete(id);
  }

  /** Get the position of a doc. @returns {number} */
  indexOf(doc) {
    return this._store.data.indexOf(doc);
  }

  /** Slice a portion of the data array. */
  slice(start, end) {
    return this._store.data.slice(start, end);
  }

  /** Replace the entire data array (used by deleteMany hard-delete). */
  replaceAll(docs) {
    this._store.data = docs;
    this._store.index.clear();
    for (const doc of docs) this._store.index.set(doc._id, doc);
  }

  /** Iterate all documents. */
  [Symbol.iterator]() {
    return this._store.data[Symbol.iterator]();
  }
}

/**
 * Resolve a query filter into plain key-value pairs suitable for insertion.
 * Strips logical operators ($or, $and, $not) and range operators ($gt, $in, etc.)
 * that have no single insert value. Resolves $eq to its wrapped value.
 * @param {object} filter
 * @returns {object}
 */
function resolveFilterToValues(filter) {
  const resolved = {};
  for (const key in filter) {
    if (key.startsWith("$")) continue;
    const val = filter[key];
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const keys = Object.keys(val);
      if (keys.length === 1 && keys[0] === "$eq") {
        resolved[key] = val.$eq;
      }
    } else {
      resolved[key] = val;
    }
  }
  return resolved;
}

/** Keys that must not appear in stored documents (prototype pollution). */
const _DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Assert a value is a plain object suitable for insert/update/upsert bodies.
 * @param {string} method - Name of the calling method, included in the error.
 * @param {*} value
 * @param {string} [what="item"] - Noun describing the argument.
 */
function _assertPlainObject(method, value, what = "item") {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(
      "ERR_SKALEX_VALIDATION_ARG",
      `${method}() expects a plain object ${what}, got ${value === null ? "null" : Array.isArray(value) ? "array" : typeof value}`,
      { method, got: value === null ? "null" : Array.isArray(value) ? "array" : typeof value }
    );
  }
}

/**
 * Assert a value is a filter argument (object or function).
 * @param {string} method
 * @param {*} value
 */
function _assertFilter(method, value) {
  if (value == null) return;
  const type = typeof value;
  if (type === "function") return;
  if (type === "object" && !Array.isArray(value)) return;
  throw new ValidationError(
    "ERR_SKALEX_VALIDATION_ARG",
    `${method}() expects a filter object or function, got ${Array.isArray(value) ? "array" : type}`,
    { method, got: Array.isArray(value) ? "array" : type }
  );
}

/**
 * Recursively strip dangerous keys from a value before storing.
 * Returns the value unchanged for non-object types and arrays.
 * @param {*} val
 * @returns {*}
 */
function stripDangerousKeys(val) {
  if (typeof val !== "object" || val === null || Array.isArray(val)) return val;
  const out = {};
  for (const k of Object.keys(val)) {
    if (_DANGEROUS_KEYS.has(k)) continue;
    out[k] = stripDangerousKeys(val[k]);
  }
  return out;
}

/**
 * Pre-compile $regex string values in a filter into RegExp objects so
 * matchesFilter skips the per-doc compileRegexFilter overhead. Operates
 * on a shallow copy of the filter to avoid mutating the caller's object.
 * Already-compiled RegExp instances are left untouched.
 * @param {object|null} filter
 * @returns {object|null}
 */
function _precompileRegex(filter) {
  if (!filter || typeof filter !== "object") return filter;
  let copy = null;
  for (const key in filter) {
    const val = filter[key];
    if (key === "$or" || key === "$and") {
      if (Array.isArray(val)) {
        const compiled = val.map(sub => _precompileRegex(sub));
        // Only allocate a copy if a child filter actually compiled something.
        if (compiled.some((c, i) => c !== val[i])) {
          if (!copy) copy = { ...filter };
          copy[key] = compiled;
        }
      }
    } else if (key === "$not") {
      const compiled = _precompileRegex(val);
      if (compiled !== val) {
        if (!copy) copy = { ...filter };
        copy[key] = compiled;
      }
    } else if (val && typeof val === "object" && !Array.isArray(val) && "$regex" in val && !(val.$regex instanceof RegExp)) {
      if (!copy) copy = { ...filter };
      copy[key] = { ...val, $regex: compileRegexFilter(val.$regex) };
    }
  }
  return copy || filter;
}

/**
 * Collection represents a collection of documents in the database.
 */
class Collection {
  /**
   * @param {object} collectionData - Internal store object managed by the registry.
   * @param {object} ctxOrDb - CollectionContext, or legacy Skalex instance
   *   (backward compat: if it has `_collectionContext`, it's a Skalex instance).
   */
  constructor(collectionData, ctxOrDb) {
    this.name = collectionData.collectionName;

    /**
     * @type {CollectionContext} Narrow dependency surface for Collection operations.
     * Shared across all collections of a Skalex instance - the ctx uses lazy
     * getters that defer to the database, so a single allocation suffices.
     */
    this._ctx = ctxOrDb._collectionContext ?? ctxOrDb;

    this._setStore(collectionData);
    this._pipeline = new MutationPipeline(this);

    /** @type {number|null} If created inside a transaction, the tx ID. */
    this._createdInTxId = this._ctx.txManager.context?.id ?? null;

    /** @type {number|null} Set by the tx proxy when obtained via tx.useCollection(). */
    this._activeTxId = null;
  }

  /** Update the backing store and re-wrap the DataStore. Called by loadData sync. */
  _setStore(store) {
    this.__store = store;
    this._ds = new InMemoryDataStore(store);
  }
  get _store() { return this.__store; }
  set _store(val) { this._setStore(val); }

  get [Symbol.toStringTag]() { return "Collection"; }

  get _data() { return this.__store.data; }
  set _data(val) { this.__store.data = val; }
  get _index() { return this.__store.index; }

  /** @returns {import("./indexes")|null} Secondary field index engine. */
  get _fieldIndex() { return this._store.fieldIndex || null; }

  /** @returns {Map<string, object>|null} Parsed schema fields. */
  get _schema() { return this._store.schema ? this._store.schema.fields : null; }

  /** @returns {boolean} Whether changelog is enabled for this collection. */
  get _changelogEnabled() { return this._store.changelog === true; }

  /** @returns {boolean} Whether soft-delete is enabled for this collection. */
  get _softDelete() { return this._store.softDelete === true; }

  /** @returns {boolean} Whether document versioning is enabled for this collection. */
  get _versioning() { return this._store.versioning === true; }

  /** @returns {boolean} Whether strict mode (reject unknown fields) is enabled. */
  get _strict() { return this._store.strict === true; }

  /** @returns {"throw"|"warn"|"strip"} Schema error handling strategy. */
  get _onSchemaError() { return this._store.onSchemaError ?? "throw"; }

  /** @returns {number|string|null} Default TTL applied to every inserted document. */
  get _defaultTtl() { return this._store.defaultTtl || null; }

  /** @returns {string|null} Default field to embed on every inserted document. */
  get _defaultEmbed() { return this._store.defaultEmbed || null; }

  /** @returns {number|null} Maximum number of documents (capped collection). */
  get _maxDocs() { return this._store.maxDocs || null; }

  // ─── Insert ──────────────────────────────────────────────────────────────

  /**
   * Insert a single document.
   * @param {object} item
   * @param {{ save?: boolean, ifNotExists?: boolean, ttl?: number|string, embed?: string|Function, session?: string }} [options]
   * @returns {Promise<object>}
   */
  async insertOne(item, options = {}) {
    _assertPlainObject("insertOne", item);
    const { save, ifNotExists, ttl, embed, session } = options;

    if (ifNotExists) {
      await this._ctx.ensureConnected();
      const existing = this._findRaw(item);
      if (existing) return stripVector({ ...existing });
    }

    const { docs } = await this._insertCore([item], { ttl, embed, session, save });
    return stripVector(docs[0]);
  }

  /**
   * Insert multiple documents.
   * @param {object[]} items
   * @param {{ save?: boolean, ttl?: number|string, embed?: string|Function, session?: string }} [options]
   * @returns {Promise<object[]>}
   */
  async insertMany(items, options = {}) {
    if (!Array.isArray(items)) {
      throw new ValidationError(
        "ERR_SKALEX_VALIDATION_ARG",
        `insertMany() expects an array of objects, got ${items === null ? "null" : typeof items}`,
        { method: "insertMany", got: items === null ? "null" : typeof items }
      );
    }
    for (let i = 0; i < items.length; i++) _assertPlainObject("insertMany", items[i], `item at index ${i}`);
    const { save, ttl, embed, session } = options;
    const { docs } = await this._insertCore(items, { ttl, embed, session, save });
    return docs.map(stripVector);
  }

  /**
   * Shared insert implementation for one or many documents.
   * @param {object[]} items
   * @param {{ ttl?, embed?, session?, save? }} opts
   * @returns {Promise<{ docs: object[] }>}
   */
  _insertCore(items, { ttl, embed, session, save }) {
    return this._pipeline.execute({
      op: Ops.INSERT,
      beforeHook: null, // handled per-item inside mutate
      afterHook: Hooks.AFTER_INSERT,
      hookPayload: null,
      save,
      session,
      mutate: async (assertTxAlive) => {
        const newItems = [];
        const batchIds = new Set();
        for (const item of items) {
          const validated = this._applyValidation(item);
          await this._ctx.plugins.run(Hooks.BEFORE_INSERT, { collection: this.name, doc: validated });
          const newItem = await this._buildDoc(validated, { ttl, embed });
          if (this._ds.has(newItem._id) || batchIds.has(newItem._id)) {
            throw new UniqueConstraintError("ERR_SKALEX_UNIQUE_DUPLICATE_ID", `Duplicate _id "${newItem._id}" in collection "${this.name}"`, { id: newItem._id, collection: this.name });
          }
          batchIds.add(newItem._id);
          newItems.push(newItem);
        }

        assertTxAlive(); // guard before first in-memory state change
        if (this._fieldIndex) this._fieldIndex.assertUniqueBatch(newItems);
        for (const newItem of newItems) this._addToIndex(newItem);
        this._ds.push(...newItems);
        const evicted = this._enforceCapAfterInsert();
        // Emit delete events for FIFO-evicted documents so watch listeners
        // observe their disappearance alongside the corresponding inserts.
        for (const doc of evicted) {
          this._ctx.emitEvent(this.name, {
            op: Ops.DELETE,
            collection: this.name,
            doc: stripVector(doc),
          });
        }

        return { docs: newItems };
      },
    });
  }

  // ─── Update ──────────────────────────────────────────────────────────────

  /**
   * Update the first matching document.
   * @param {object} filter
   * @param {object} update
   * @param {{ save?: boolean, session?: string }} [options]
   * @returns {Promise<object|null>}
   */
  async updateOne(filter, update, options = {}) {
    _assertFilter("updateOne", filter);
    _assertPlainObject("updateOne", update, "update");
    await this._ctx.ensureConnected();
    const oldDoc = this._findRaw(filter);
    if (!oldDoc) return null;

    const { save, session } = options;
    const { docs } = await this._updateCore([oldDoc], filter, update, { save, session });
    return stripVector(docs[0]);
  }

  /**
   * Update all matching documents.
   * @param {object} filter
   * @param {object} update
   * @param {{ save?: boolean, session?: string }} [options]
   * @returns {Promise<object[]>}
   */
  async updateMany(filter, update, options = {}) {
    _assertFilter("updateMany", filter);
    _assertPlainObject("updateMany", update, "update");
    await this._ctx.ensureConnected();
    const oldDocs = this._findAllRaw(filter);
    if (oldDocs.length === 0) return [];

    const { save, session } = options;
    const { docs } = await this._updateCore(oldDocs, filter, update, { save, session });
    return docs.map(stripVector);
  }

  /**
   * Shared update implementation for one or many documents.
   */
  _updateCore(oldDocs, filter, update, { save, session }) {
    return this._pipeline.execute({
      op: Ops.UPDATE,
      beforeHook: Hooks.BEFORE_UPDATE,
      afterHook: Hooks.AFTER_UPDATE,
      hookPayload: { collection: this.name, filter, update },
      save,
      session,
      afterHookPayload: (docs) => ({ collection: this.name, filter, update, result: docs.length === 1 ? docs[0] : docs }),
      mutate: (assertTxAlive) => {
        const needsPrev = this._changelogEnabled || this._onSchemaError === "strip";
        const prevDocs = this._changelogEnabled ? oldDocs.map(doc => structuredClone(doc)) : oldDocs.map(() => null);
        const nextDocs = oldDocs.map(doc => this._prepareUpdatedDoc(doc, update, { needsPrev }));

        this._assertUniqueCandidates(oldDocs, nextDocs);

        assertTxAlive(); // guard before first in-memory state change
        // Pre-compute positions in one pass to avoid O(n) indexOf per doc.
        const targets = new Set(oldDocs);
        const positions = new Map();
        for (let i = 0; i < this._ds.data.length; i++) {
          if (targets.has(this._ds.data[i])) positions.set(this._ds.data[i], i);
        }
        for (let i = 0; i < oldDocs.length; i++) {
          this._commitUpdatedDoc(oldDocs[i], nextDocs[i], positions);
        }

        return { docs: nextDocs, prevDocs };
      },
    });
  }

  /**
   * Apply an update descriptor to a document in place.
   * Supports $inc, $push, and direct assignment. Increments _version when versioning is on.
   * Skips _id, createdAt, and updatedAt - these are system-managed. A user-provided
   * `updatedAt` value is silently discarded; the field is always set to the current
   * time on every successful update. Does NOT update indexes - the caller is
   * responsible for index maintenance (see _commitUpdatedDoc).
   * @param {object} item
   * @param {object} update
   * @returns {object} The mutated document.
   */
  applyUpdate(item, update) {
    for (const field in update) {
      if (_DANGEROUS_KEYS.has(field)) continue;
      if (field === "_id" || field === "createdAt" || field === "updatedAt") continue;
      const updateValue = update[field];

      if (Array.isArray(updateValue)) {
        // Direct array assignment - must come before the generic object check
        // because for...in on [] yields zero iterations and the value would be lost.
        item[field] = updateValue;
      } else if (typeof updateValue === "object" && updateValue !== null) {
        // Determine whether this is an operator object ($inc, $push) or a
        // plain nested value to assign directly. If ANY key starts with $,
        // treat the entire object as operators - plain keys are ignored to
        // prevent overwriting the field with the operator descriptor.
        const keys = Object.keys(updateValue);
        const hasOperators = keys.some(k => k.startsWith("$"));

        if (hasOperators) {
          for (const key of keys) {
            if (key === "$inc" && typeof item[field] === "number") {
              item[field] += updateValue[key];
            } else if (key === "$push") {
              if (!Array.isArray(item[field])) item[field] = [];
              item[field].push(updateValue[key]);
            }
            // Non-$ keys inside an operator object are silently ignored.
          }
        } else {
          // Plain nested object - strip dangerous keys recursively.
          item[field] = stripDangerousKeys(updateValue);
        }
      } else {
        item[field] = updateValue;
      }
    }

    item.updatedAt = new Date();
    if (this._versioning) item._version = (item._version ?? 0) + 1;
    return item;
  }

  /**
   * Build the next persisted document state without mutating the live document.
   * Validation runs against the candidate so updateMany() can remain all-or-nothing.
   * @param {object} currentDoc
   * @param {object} update
   * @returns {object}
   */
  _prepareUpdatedDoc(currentDoc, update, { needsPrev = true } = {}) {
    // Clone prev only when changelog is enabled or onSchemaError is "strip".
    // Skipping this clone halves the structuredClone cost on the update hot path
    // for the common case where changelog is off and schema validation is
    // "throw" or "warn".
    const prev = needsPrev ? structuredClone(currentDoc) : null;
    const next = structuredClone(currentDoc);

    this.applyUpdate(next, update);

    if (!this._schema) return next;

    const errors = validateDoc(next, this._schema, this._strict);
    if (!errors.length) return next;

    switch (this._onSchemaError) {
      case "throw":
        throw new ValidationError("ERR_SKALEX_VALIDATION_UPDATE", `Update validation failed on doc "${currentDoc._id}": ${errors.join("; ")}`, { id: currentDoc._id, errors });
      case "strip":
        return this._stripCandidateToValid(next, prev);
      default:
        this._ctx.logger(`[${this.name}] Update validation warning: ${errors.join("; ")}`, "warn");
        return next;
    }
  }

  /**
   * Keep valid changes from a candidate doc while preserving prior values for
   * invalid fields.
   * @param {object} next
   * @param {object} prev
   * @returns {object}
   */
  _stripCandidateToValid(next, prev) {
    const stripped = stripInvalidFields(next, this._schema);
    const merged = structuredClone(prev);

    for (const [key, val] of Object.entries(stripped)) {
      if (key.startsWith("_")) continue;
      merged[key] = val;
    }

    merged.updatedAt = next.updatedAt;
    if (this._versioning) merged._version = next._version;
    return merged;
  }

  /**
   * Replace a live document with a prepared document and update all indexes.
   * @param {object} oldDoc
   * @param {object} newDoc
   * @param {Map<object, number>} [positions] - Pre-computed _data index positions
   *   to avoid O(n) indexOf per call. When omitted, falls back to indexOf.
   */
  _commitUpdatedDoc(oldDoc, newDoc, positions) {
    const idx = positions ? positions.get(oldDoc) : this._ds.indexOf(oldDoc);
    if (idx === undefined || idx === -1) {
      throw new PersistenceError("ERR_SKALEX_PERSISTENCE_DOC_MISSING", `Document "${oldDoc._id}" no longer exists in collection "${this.name}"`, { id: oldDoc._id, collection: this.name });
    }
    this._ds.replaceAt(idx, newDoc);
    this._updateInIndex(oldDoc, newDoc);
  }

  /**
   * Validate unique constraints for a batch of prepared updates before any live
   * document or index state is mutated.
   * @param {object[]} oldDocs
   * @param {object[]} nextDocs
   */
  _assertUniqueCandidates(oldDocs, nextDocs) {
    this._fieldIndex?.assertUniqueCandidates(oldDocs, nextDocs);
  }

  // ─── Upsert ──────────────────────────────────────────────────────────────

  /**
   * Update the first matching document, or insert if none exists.
   * @param {object} filter
   * @param {object} doc
   * @param {{ save?: boolean }} [options]
   * @returns {Promise<object>}
   */
  async upsert(filter, doc, options = {}) {
    _assertFilter("upsert", filter);
    _assertPlainObject("upsert", doc, "doc");
    await this._ctx.ensureConnected();
    const existing = this._findRaw(filter);
    if (existing) {
      return this.updateOne(filter, doc, options);
    }
    return this.insertOne({ ...resolveFilterToValues(filter), ...doc }, options);
  }

  /**
   * Batch upsert: for each doc in `docs`, match on `matchKey` and update or insert.
   * A single save is issued at the end (honouring autoSave).
   * @param {object[]} docs
   * @param {string} matchKey
   * @param {{ save?: boolean, ttl?: number|string, embed?: string|Function, session?: string }} [options]
   * @returns {Promise<object[]>}
   */
  async upsertMany(docs, matchKey, options = {}) {
    if (!Array.isArray(docs)) {
      throw new ValidationError(
        "ERR_SKALEX_VALIDATION_ARG",
        `upsertMany() expects an array of documents, got ${docs === null ? "null" : typeof docs}`,
        { method: "upsertMany" }
      );
    }
    if (typeof matchKey !== "string" || !matchKey) {
      throw new ValidationError(
        "ERR_SKALEX_VALIDATION_ARG",
        `upsertMany() expects matchKey to be a non-empty string, got ${typeof matchKey}`,
        { method: "upsertMany" }
      );
    }
    for (let i = 0; i < docs.length; i++) _assertPlainObject("upsertMany", docs[i], `doc at index ${i}`);
    if (docs.length === 0) return [];

    const { save, ttl, embed, session } = options;

    // Route the whole batch through a single pipeline pass so `ensureConnected`,
    // lock check, `_txSnapshotIfNeeded`, `markDirty`, `_saveIfNeeded`, and the
    // session-stats increment all run once instead of once per document.
    // Per-doc plugin hooks (beforeInsert/beforeUpdate inside the closure;
    // afterInsert/afterUpdate outside) preserve the contract consumers rely on.
    const result = await this._pipeline.executeBatch({
      op: Ops.UPDATE,
      save,
      session,
      mutateBatch: async (assertTxAlive) => {
        const outDocs = [];
        const prevDocs = [];
        const ops = [];
        const newInserts = [];
        const batchIds = new Set();

        for (const raw of docs) {
          const filter = { [matchKey]: raw[matchKey] };
          const existing = this._findRaw(filter);

          if (existing) {
            // Update path - mirrors _updateCore's single-doc flow.
            await this._ctx.plugins.run(Hooks.BEFORE_UPDATE, {
              collection: this.name,
              filter,
              update: raw,
            });
            const needsPrev = this._changelogEnabled || this._onSchemaError === "strip";
            const prev = this._changelogEnabled ? structuredClone(existing) : null;
            const next = this._prepareUpdatedDoc(existing, raw, { needsPrev });
            this._assertUniqueCandidates([existing], [next]);

            assertTxAlive();
            const idx = this._ds.indexOf(existing);
            if (idx === -1) {
              throw new PersistenceError(
                "ERR_SKALEX_PERSISTENCE_DOC_MISSING",
                `Document "${existing._id}" no longer exists in collection "${this.name}"`,
                { id: existing._id, collection: this.name }
              );
            }
            this._ds.replaceAt(idx, next);
            this._updateInIndex(existing, next);

            outDocs.push(next);
            prevDocs.push(prev);
            ops.push(Ops.UPDATE);
          } else {
            // Insert path - mirrors _insertCore's per-doc flow.
            const body = { ...resolveFilterToValues(filter), ...raw };
            const validated = this._applyValidation(body);
            await this._ctx.plugins.run(Hooks.BEFORE_INSERT, {
              collection: this.name,
              doc: validated,
            });
            const newDoc = await this._buildDoc(validated, { ttl, embed });
            if (this._ds.has(newDoc._id) || batchIds.has(newDoc._id)) {
              throw new UniqueConstraintError(
                "ERR_SKALEX_UNIQUE_DUPLICATE_ID",
                `Duplicate _id "${newDoc._id}" in collection "${this.name}"`,
                { id: newDoc._id, collection: this.name }
              );
            }
            batchIds.add(newDoc._id);
            newInserts.push(newDoc);

            assertTxAlive();
            if (this._fieldIndex) this._fieldIndex.assertUniqueBatch([newDoc]);
            this._addToIndex(newDoc);
            this._ds.push(newDoc);

            outDocs.push(newDoc);
            prevDocs.push(null);
            ops.push(Ops.INSERT);
          }
        }

        // Apply FIFO capacity enforcement once after all inserts land.
        if (newInserts.length > 0) {
          const evicted = this._enforceCapAfterInsert();
          for (const doc of evicted) {
            this._ctx.emitEvent(this.name, {
              op: Ops.DELETE,
              collection: this.name,
              doc: stripVector(doc),
            });
          }
        }

        return { docs: outDocs, prevDocs, ops };
      },
    });

    // Fire per-doc after hooks outside the mutate closure so they see the
    // committed state, matching updateOne/insertOne behavior.
    for (let i = 0; i < result.docs.length; i++) {
      const doc = stripVector(result.docs[i]);
      if (result.ops[i] === Ops.INSERT) {
        await this._ctx.runAfterHook(Hooks.AFTER_INSERT, {
          collection: this.name,
          doc,
        });
      } else {
        await this._ctx.runAfterHook(Hooks.AFTER_UPDATE, {
          collection: this.name,
          filter: { [matchKey]: docs[i][matchKey] },
          update: docs[i],
          result: doc,
        });
      }
    }

    return result.docs.map(stripVector);
  }

  // ─── Soft-delete restore ──────────────────────────────────────────────────

  /**
   * Restore a soft-deleted document (undo a soft delete).
   * Requires the collection to have softDelete enabled.
   * @param {object} filter
   * @param {{ save?: boolean, session?: string }} [options]
   * @returns {Promise<object|null>}
   */
  async restore(filter, options = {}) {
    _assertFilter("restore", filter);
    if (!this._softDelete) throw new QueryError("ERR_SKALEX_QUERY_SOFT_DELETE_REQUIRED", `restore() requires softDelete on "${this.name}"`, { collection: this.name });
    await this._ctx.ensureConnected();
    const { save, session } = options;

    const item = this._findRaw(filter, { includeDeleted: true });
    if (!item || !item._deletedAt) return null;

    const { docs } = await this._pipeline.execute({
      op: Ops.RESTORE,
      beforeHook: null,
      afterHook: Hooks.AFTER_RESTORE,
      hookPayload: null,
      save,
      session,
      afterHookPayload: (restored) => ({ collection: this.name, filter, docs: restored }),
      mutate: (assertTxAlive) => {
        assertTxAlive();
        delete item._deletedAt;
        item.updatedAt = new Date();
        this._ds.setInIndex(item._id, item);
        return { docs: [item] };
      },
    });
    return stripVector(docs[0]);
  }

  // ─── Watch ───────────────────────────────────────────────────────────────

  /**
   * Watch for mutation events on this collection.
   *
   * Callback form - returns an unsubscribe function:
   *   const unsub = col.watch({ status: "active" }, event => console.log(event));
   *   unsub(); // stop watching
   *
   * AsyncIterator form - no callback:
   *   for await (const event of col.watch({ status: "active" })) { ... }
   *
   * The iterator form accepts an options object as the second argument:
   *   col.watch(filter, { maxBufferSize: 500 })
   *
   * When the buffer is full, the oldest events are dropped. The `dropped`
   * property on the returned iterator reports how many events were lost.
   *
   * Event shape: { op: "insert"|"update"|"delete"|"restore", collection, doc, prev? }
   *
   * @param {object|Function} [filter]
   * @param {Function|object} [callbackOrOpts] - callback function or { maxBufferSize }
   * @returns {(() => void)|AsyncIterableIterator}
   */
  watch(filter, callbackOrOpts) {
    // watch(callback) shorthand - no filter
    if (typeof filter === "function") { callbackOrOpts = filter; filter = null; }

    if (typeof callbackOrOpts === "function") {
      // Callback-based API - returns unsub fn
      return this._ctx.eventBus.on(this.name, event => {
        if (!filter || matchesFilter(event.doc, filter)) callbackOrOpts(event);
      });
    }

    // AsyncIterator API
    const { maxBufferSize = 1000 } = callbackOrOpts || {};
    return this._watchIterator(filter, Math.max(1, maxBufferSize));
  }

  _watchIterator(filter, maxBufferSize) {
    const queue = [];
    let resolve = null;
    let done = false;
    let dropped = 0;

    const unsub = this._ctx.eventBus.on(this.name, event => {
      if (filter && !matchesFilter(event.doc, filter)) return;
      if (resolve) {
        const r = resolve; resolve = null;
        r({ value: event, done: false });
      } else {
        if (queue.length >= maxBufferSize) {
          queue.shift();
          dropped++;
        }
        queue.push(event);
      }
    });

    return {
      [Symbol.asyncIterator]() { return this; },
      get dropped() { return dropped; },
      next() {
        if (queue.length > 0) return Promise.resolve({ value: queue.shift(), done: false });
        if (done) return Promise.resolve({ value: undefined, done: true });
        return new Promise(res => { resolve = res; });
      },
      return() {
        done = true; unsub();
        if (resolve) { const r = resolve; resolve = null; r({ value: undefined, done: true }); }
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }

  // ─── Aggregation ─────────────────────────────────────────────────────────

  /**
   * Count documents matching a filter.
   * @param {object} [filter={}]
   * @returns {Promise<number>}
   */
  async count(filter = {}) {
    await this._ctx.ensureConnected();
    return count(this._findAllRaw(filter));
  }

  /**
   * Sum a numeric field across matching documents.
   * @param {string} field
   * @param {object} [filter={}]
   * @returns {Promise<number>}
   */
  async sum(field, filter = {}) {
    await this._ctx.ensureConnected();
    return sum(this._findAllRaw(filter), field);
  }

  /**
   * Average a numeric field across matching documents.
   * Returns null when no matching numeric values exist.
   * @param {string} field
   * @param {object} [filter={}]
   * @returns {Promise<number|null>}
   */
  async avg(field, filter = {}) {
    await this._ctx.ensureConnected();
    return avg(this._findAllRaw(filter), field);
  }

  /**
   * Group matching documents by a field value.
   * Returns `{ [value]: docs[] }`.
   * @param {string} field
   * @param {object} [filter={}]
   * @returns {Promise<Record<string, object[]>>}
   */
  async groupBy(field, filter = {}) {
    await this._ctx.ensureConnected();
    return groupBy(this._findAllRaw(filter), field);
  }

  // ─── Find ─────────────────────────────────────────────────────────────────

  /**
   * Find the first matching document (returns a shallow copy with projection).
   * @param {object} filter
   * @param {{ populate?: string[], select?: string[], includeDeleted?: boolean }} [options]
   * @returns {Promise<object|null>}
   */
  async findOne(filter, options = {}) {
    _assertFilter("findOne", filter);
    await this._ctx.ensureConnected();
    const { populate, select, includeDeleted = false } = options;
    const item = this._findRaw(filter, { includeDeleted });
    if (!item) return null;

    const newItem = this._projectDoc(item, select);
    if (populate) await this._populateDoc(newItem, item, populate);
    return newItem;
  }

  /**
   * Find all matching documents.
   *
   * **Limit-only fast path:** when `limit` is set, `sort` is absent, and
   * `page` is 1 (default), scanning stops after `limit` matches. In this
   * mode `totalDocs` and `totalPages` are omitted from the result because
   * the total is unknown without a full scan. Callers that need totals
   * should pass an explicit `sort` or `page` to disable the fast path.
   *
   * @param {object} filter
   * @param {{ populate?: string[], select?: string[], sort?: object, page?: number, limit?: number, includeDeleted?: boolean }} [options]
   * @returns {Promise<{ docs: object[], page?: number, totalDocs?: number, totalPages?: number }>}
   */
  async find(filter, options = {}) {
    _assertFilter("find", filter);
    await this._ctx.ensureConnected();
    const _t0 = Date.now();
    const { populate, select, sort, page = 1, limit, session, includeDeleted = false } = options;

    await this._ctx.plugins.run(Hooks.BEFORE_FIND, { collection: this.name, filter, options });

    const candidates = this._getCandidates(filter);
    // Pre-compile $regex strings once so matchesFilter doesn't run
    // compileRegexFilter per document on every iteration.
    const compiledFilter = _precompileRegex(
      presortFilter(filter, this._fieldIndex ? this._fieldIndex.indexedFields : new Set())
    );

    let results = [];

    // Limit-only fast path: when there is no sort and no page offset,
    // stop scanning after `limit` matches instead of collecting everything.
    const earlyStop = limit && !sort && page === 1;

    for (const item of candidates) {
      if (!this._isVisible(item, includeDeleted)) continue;
      if (!matchesFilter(item, compiledFilter)) continue;
      const newItem = this._projectDoc(item, select);
      if (populate) await this._populateDoc(newItem, item, populate);
      results.push(newItem);
      if (earlyStop && results.length >= limit) break;
    }

    if (sort) {
      const sortFields = Object.keys(sort);
      results.sort((a, b) => {
        for (const field of sortFields) {
          const dir = sort[field]; // 1 = ascending, -1 = descending
          if (a[field] < b[field]) return -dir;
          if (a[field] > b[field]) return dir;
        }
        return 0;
      });
    }

    let extra;
    if (limit) {
      const totalDocs = earlyStop ? undefined : results.length;
      const totalPages = earlyStop ? undefined : Math.ceil(totalDocs / limit);
      const startIndex = earlyStop ? 0 : (page - 1) * limit;
      results = earlyStop ? results : results.slice(startIndex, startIndex + limit);
      extra = earlyStop ? { page } : { page, totalDocs, totalPages };
    }

    this._ctx.queryLog?.record({ collection: this.name, op: "find", filter, duration: Date.now() - _t0, resultCount: results.length });
    this._ctx.sessionStats.recordRead(session);
    await this._ctx.plugins.run(Hooks.AFTER_FIND, { collection: this.name, filter, options, docs: results });
    return extra ? { docs: results, ...extra } : { docs: results };
  }

  // ─── Vector Search ───────────────────────────────────────────────────────

  /**
   * Semantic similarity search  -  embed a query string and rank all documents
   * with a `_vector` field by cosine similarity.
   *
   * @param {string} query
   * @param {{ filter?: object, limit?: number, minScore?: number }} [options]
   * @returns {Promise<{ docs: object[], scores: number[] }>}
   */
  async search(query, { filter, limit = 10, minScore = 0, session } = {}) {
    if (typeof query !== "string") {
      throw new ValidationError(
        "ERR_SKALEX_VALIDATION_ARG",
        `search() expects query to be a string, got ${typeof query}`,
        { method: "search" }
      );
    }
    _assertFilter("search", filter);
    await this._ctx.ensureConnected();
    const _t0 = Date.now();
    await this._ctx.plugins.run(Hooks.BEFORE_SEARCH, { collection: this.name, query, options: { filter, limit, minScore } });

    const candidates = filter ? this._findAllRaw(filter) : this._ds.data;
    const result = await vectorSearch(query, candidates, (t) => this._ctx.embed(t), { limit, minScore });

    this._ctx.queryLog?.record({ collection: this.name, op: "search", query, duration: Date.now() - _t0, resultCount: result.docs.length });
    this._ctx.sessionStats.recordRead(session);
    await this._ctx.plugins.run(Hooks.AFTER_SEARCH, { collection: this.name, query, options: { filter, limit, minScore }, docs: result.docs, scores: result.scores });

    return result;
  }

  /**
   * Find the nearest neighbours to an existing document by `_id`.
   *
   * @param {string} id
   * @param {{ limit?: number, minScore?: number }} [options]
   * @returns {Promise<{ docs: object[], scores: number[] }>}
   */
  async similar(id, { limit = 10, minScore = 0 } = {}) {
    await this._ctx.ensureConnected();
    const source = this._ds.getById(id);
    if (!source || !source._vector) return { docs: [], scores: [] };
    return similarByVector(source._vector, id, this._ds.data, { limit, minScore });
  }

  // ─── Delete ──────────────────────────────────────────────────────────────

  /**
   * Delete the first matching document.
   * When softDelete is enabled, sets `_deletedAt` instead of removing the document.
   * @param {object} filter
   * @param {{ save?: boolean, session?: string }} [options]
   * @returns {Promise<object|null>}
   */
  async deleteOne(filter, options = {}) {
    _assertFilter("deleteOne", filter);
    await this._ctx.ensureConnected();
    const { save, session } = options;

    if (this._softDelete) {
      const item = this._findRaw(filter);
      if (!item) return null;
      const { docs } = await this._deleteCore("soft", [item], filter, { save, session });
      return stripVector(docs[0]);
    }

    // Defer _findIndex to inside the mutate callback so beforeDelete hooks
    // cannot invalidate the index position between lookup and splice.
    const { docs } = await this._deleteCore("hard", null, filter, { save, session });
    if (docs.length === 0) return null;
    return stripVector(docs[0]);
  }

  /**
   * Delete all matching documents.
   * When softDelete is enabled, sets `_deletedAt` instead of removing documents.
   * @param {object} filter
   * @param {{ save?: boolean, session?: string }} [options]
   * @returns {Promise<object[]>}
   */
  async deleteMany(filter, options = {}) {
    _assertFilter("deleteMany", filter);
    await this._ctx.ensureConnected();
    const { save, session } = options;

    if (this._softDelete) {
      const items = this._findAllRaw(filter);
      if (items.length === 0) return [];
      const { docs } = await this._deleteCore("soft", items, filter, { save, session });
      return docs.map(stripVector);
    }

    // For hard delete many, collect items in one pass
    const { docs } = await this._deleteCore("hardMany", null, filter, { save, session });
    return docs.map(stripVector);
  }

  /**
   * Shared delete implementation.
   * @param {"soft"|"hard"|"hardMany"} mode
   */
  _deleteCore(mode, items, filter, { save, session }) {
    return this._pipeline.execute({
      op: Ops.DELETE,
      beforeHook: Hooks.BEFORE_DELETE,
      afterHook: Hooks.AFTER_DELETE,
      hookPayload: { collection: this.name, filter },
      save,
      session,
      afterHookPayload: (docs) => ({ collection: this.name, filter, result: docs.length === 1 ? docs[0] : docs }),
      mutate: (assertTxAlive) => {
        assertTxAlive(); // guard before first in-memory state change
        if (mode === "soft") {
          const now = new Date();
          for (const item of items) {
            item._deletedAt = now;
            item.updatedAt = now;
            this._ds.setInIndex(item._id, item);
          }
          return { docs: items };
        }

        if (mode === "hard") {
          const idx = this._findIndex(filter);
          if (idx === -1) return { docs: [] };
          const deletedItem = this._ds.spliceAt(idx);
          this._removeFromIndex(deletedItem);
          return { docs: [deletedItem] };
        }

        // hardMany
        const deletedItems = [];
        const remainingItems = [];
        for (const item of this._ds) {
          if (matchesFilter(item, filter)) {
            deletedItems.push(item);
            this._removeFromIndex(item);
          } else {
            remainingItems.push(item);
          }
        }
        // replaceAll clears and rebuilds the _id index from remaining docs,
        // so per-item deleteFromIndex calls are unnecessary.
        this._ds.replaceAll(remainingItems);
        return { docs: deletedItems };
      },
    });
  }

  // ─── Export ──────────────────────────────────────────────────────────────

  /**
   * Export filtered data to a file via the storage adapter.
   * @param {object} [filter={}]
   * @param {{ dir?: string, name?: string, format?: "json"|"csv" }} [options]
   */
  export(filter = {}, options = {}) {
    return exportData(this._ds.data, this.name, filter, options, this._ctx);
  }

  // ─── Private helpers ─────────────────────────────────────────────────────

  /**
   * Lazy snapshot for transactions: snapshot this collection on first write.
   * Only participates if the Collection was obtained through the transaction
   * proxy (_activeTxId matches the active context). Non-transactional writes
   * (Collection obtained via real db) skip the snapshot path entirely.
   */
  _txSnapshotIfNeeded() {
    const txm = this._ctx.txManager;
    if (!txm.active) return;
    if (this._activeTxId !== txm.context?.id) return;
    txm.snapshotIfNeeded(this.name, this._store, (col) => this._ctx.snapshotCollection(col));
  }

  /**
   * Save if `save` is explicitly true, or if database-level autoSave is on.
   * Pass `save: false` to opt out even when autoSave is enabled.
   * Suppressed for transactional writes (_activeTxId matches active tx) -
   * the transaction is responsible for the single flush after fn() resolves.
   * Non-transactional writes save immediately even during an active transaction.
   * @param {boolean|undefined} save
   */
  async _saveIfNeeded(save) {
    const txm = this._ctx.txManager;
    if (txm.active && this._activeTxId === txm.context?.id) return;
    if (save ?? this._ctx.autoSave) await this._ctx.saveCollection(this.name);
  }

  /**
   * Validate a document against the collection schema, applying the configured
   * error strategy: "throw" (default), "warn" (log and proceed), "strip" (remove
   * invalid fields). Returns the doc (possibly stripped) or throws on failure.
   * @param {object} item
   * @returns {object}
   */
  _applyValidation(item) {
    if (!this._schema) return item;
    const errors = validateDoc(item, this._schema, this._strict);
    if (!errors.length) return item;
    switch (this._onSchemaError) {
      case "warn":
        // `warn` mode admits invalid docs silently - log the id and errors so
        // schema drift is auditable. Callers should prefer `throw` in strict
        // pipelines; `warn` does NOT prevent invalid data from being persisted.
        this._ctx.logger(
          `[${this.name}] Validation warning for doc "${item._id ?? "(new)"}": ${errors.join("; ")}`,
          "warn"
        );
        return item;
      case "strip":
        return stripInvalidFields(item, this._schema);
      default:
        throw new ValidationError("ERR_SKALEX_VALIDATION_FAILED", `Validation failed: ${errors.join("; ")}`, { errors });
    }
  }

  /**
   * Evict oldest documents when the collection exceeds `maxDocs`.
   * FIFO: the earliest-inserted documents are removed first.
   *
   * Atomicity: candidates are collected first, then removed from all indexes.
   * Each doc is tracked by removal state so that a mid-batch failure can
   * restore exactly the indexes that were touched, leaving `_data` and both
   * indexes internally consistent.
   *
   * `_data.splice()` runs only after every index removal succeeds, so a
   * failure leaves `_data` untouched - callers can rely on "either every
   * eviction committed or none did".
   *
   * @returns {object[]} The evicted documents (for caller-side event emission).
   */
  _enforceCapAfterInsert() {
    const max = this._maxDocs;
    if (!max || this._ds.count() <= max) return [];
    const evictCount = this._ds.count() - max;
    const toEvict = this._ds.slice(0, evictCount);

    // Per-doc removal state:
    //   0 = untouched
    //   1 = removed from id-index
    //   2 = removed from id-index AND field-index
    const states = new Array(toEvict.length).fill(0);
    try {
      for (let i = 0; i < toEvict.length; i++) {
        const doc = toEvict[i];
        this._ds.deleteFromIndex(doc._id);
        states[i] = 1;
        this._removeFromIndex(doc);
        states[i] = 2;
      }
      this._ds.spliceRange(0, evictCount);
      return toEvict;
    } catch (err) {
      // Restore in reverse order. For each doc, undo exactly the steps that
      // were committed. This leaves data + both indexes consistent.
      for (let i = toEvict.length - 1; i >= 0; i--) {
        const doc = toEvict[i];
        if (states[i] === 0) continue;
        if (states[i] === 2) {
          try { this._addToIndex(doc); } catch { /* best-effort */ }
        }
        // states 1 and 2 both require id-index restore
        this._ds.setInIndex(doc._id, doc);
      }
      throw err;
    }
  }

  /**
   * Whether a document is visible given the collection's soft-delete setting.
   * @param {object} doc
   * @param {boolean} [includeDeleted]
   * @returns {boolean}
   */
  _isVisible(doc, includeDeleted = false) {
    return !this._softDelete || !doc._deletedAt || includeDeleted;
  }

  _findRaw(filter, opts) {
    return findRaw(filter, this._ds.data, this._ds.index, this._fieldIndex, (doc, incl) => this._isVisible(doc, incl), opts);
  }

  _findAllRaw(filter, opts) {
    return findAllRaw(filter, this._ds.data, this._ds.index, this._fieldIndex, (doc, incl) => this._isVisible(doc, incl), opts);
  }

  _getCandidates(filter) {
    return getCandidates(filter, this._ds.data, this._fieldIndex);
  }

  _findIndex(filter) {
    return findIndex(filter, this._ds.data);
  }

  // ─── Rehydrate (changelog restore) ───────────────────────────────────────

  /**
   * Replace the entire collection state with the given archived documents.
   * Used by `ChangeLog.restore()` to replay historical state faithfully:
   * `_id`, `createdAt`, `updatedAt`, `_version`, `_expiresAt`, and `_vector`
   * are preserved exactly as archived. Plugins, changelog logging,
   * validation, schema checks, and FIFO cap enforcement are bypassed
   * because the archived state was already valid when it was captured.
   *
   * Watch events ARE emitted so external observers (search indexes, caches,
   * reactive UIs) stay in sync with the collection's new state. The set of
   * events mirrors what a naive `deleteMany({})` + per-doc `insertOne`
   * implementation would emit: one `delete` per pre-restore document, then
   * one `insert` per restored document. Plugin hooks are intentionally NOT
   * fired - their contract assumes fresh user-initiated writes, not
   * historical replay.
   *
   * Not public API - invoked only from `ChangeLog.restore()`.
   *
   * @param {object[]} docs - Archived documents in their final-state form.
   */
  _rehydrateAll(docs) {
    // Snapshot old docs for event emission before state is replaced.
    const previous = this._ds.data.slice();
    const replacement = docs.map(d => ({ ...d }));
    // `replaceAll` swaps the data array and rebuilds the primary _id index.
    this._ds.replaceAll(replacement);
    if (this._fieldIndex) this._fieldIndex.buildFromData(this._ds.data);
    this._ctx.persistence.markDirty(this._ctx.collections, this.name);

    // Emit per-doc events so watch listeners observe the replacement.
    for (const doc of previous) {
      this._ctx.emitEvent(this.name, {
        op: Ops.DELETE,
        collection: this.name,
        doc: stripVector(doc),
      });
    }
    for (const doc of replacement) {
      this._ctx.emitEvent(this.name, {
        op: Ops.INSERT,
        collection: this.name,
        doc: stripVector(doc),
      });
    }
  }

  /**
   * Replace (or remove) a single document with an archived state. Used for
   * per-document `ChangeLog.restore()` so timestamps and other system
   * fields come back exactly as they were archived.
   *
   * Emits a watch event for the observed transition (delete / update /
   * insert depending on whether the document existed before and after).
   * Plugin hooks are intentionally NOT fired - see `_rehydrateAll`.
   *
   * @param {string} id - Document _id to restore.
   * @param {object|null} archived - Archived doc snapshot, or null when the
   *   document should not exist at the restored timestamp.
   */
  _rehydrateOne(id, archived) {
    const existing = this._ds.getById(id);
    if (archived == null) {
      if (!existing) return;
      const removedSnapshot = stripVector(existing);
      const idx = this._ds.indexOf(existing);
      if (idx !== -1) {
        this._removeFromIndex(existing);
        this._ds.spliceAt(idx);
      }
      this._ctx.persistence.markDirty(this._ctx.collections, this.name);
      this._ctx.emitEvent(this.name, {
        op: Ops.DELETE,
        collection: this.name,
        doc: removedSnapshot,
      });
      return;
    }
    const clone = { ...archived };
    let op;
    if (existing) {
      const idx = this._ds.indexOf(existing);
      if (idx === -1) return;
      this._ds.replaceAt(idx, clone);
      this._updateInIndex(existing, clone);
      op = Ops.UPDATE;
    } else {
      this._ds.push(clone);
      this._addToIndex(clone);
      op = Ops.INSERT;
    }
    this._ctx.persistence.markDirty(this._ctx.collections, this.name);
    this._ctx.emitEvent(this.name, {
      op,
      collection: this.name,
      doc: stripVector(clone),
    });
  }

  // ─── Private index helpers ────────────────────────────────────────────────

  _addToIndex(doc) {
    if (this._fieldIndex) this._fieldIndex.add(doc);
  }

  _removeFromIndex(doc) {
    if (this._fieldIndex) this._fieldIndex.remove(doc);
  }

  _updateInIndex(oldDoc, doc) {
    if (this._fieldIndex) this._fieldIndex.update(oldDoc, doc);
  }

  // ─── Private document construction ───────────────────────────────────────

  /**
   * Build a new document from a raw item: assign _id/timestamps, apply TTL,
   * embed vector, and set initial _version when versioning is on.
   * @param {object} item
   * @param {{ ttl?: number|string, embed?: string|Function }} [opts]
   * @returns {Promise<object>}
   */
  _buildDoc(item, { ttl, embed } = {}) {
    return buildDoc(item, {
      ttl,
      embed,
      defaultTtl: this._defaultTtl,
      defaultEmbed: this._defaultEmbed,
      versioning: this._versioning,
      idGenerator: this._ctx.idGenerator,
      embedFn: (text) => this._ctx.embed(text),
    });
  }

  // ─── Private projection / population helpers ──────────────────────────────

  /**
   * Return a shallow copy of doc with optional field projection.
   * Strips _vector when no select is given.
   * @param {object} doc
   * @param {string[]|undefined} select
   * @returns {object}
   */
  _projectDoc(doc, select) {
    if (select) {
      const out = {};
      for (const field of select) {
        if (field === "_vector") continue;
        out[field] = doc[field];
      }
      return out;
    }
    const out = { ...doc };
    delete out._vector;
    return out;
  }

  /**
   * Populate foreign-key fields on an already-projected document.
   * Mutates `out` in place.
   * @param {object} out     - The projected doc to populate into.
   * @param {object} source  - The raw doc holding the FK values.
   * @param {string[]} fields
   * @returns {Promise<void>}
   */
  async _populateDoc(out, source, fields) {
    for (const field of fields) {
      const related = this._ctx.getCollection(field);
      const item = await related.findOne({ _id: source[field] });
      if (item) out[field] = item;
    }
  }
}

var nodePath = {};

var nodeFs = {};

var zlib = {};

/**
 * StorageAdapter  -  interface all storage backends must implement.
 *
 * All methods are async. `name` is a collection identifier string
 * (no path separators  -  the adapter maps it to its own storage scheme).
 */
class StorageAdapter {
  /**
   * Read a collection file. Returns the raw string content, or null if not found.
   * @param {string} name
   * @returns {Promise<string|null>}
   */
  async read(name) {
    throw new AdapterError("ERR_SKALEX_ADAPTER_NOT_IMPLEMENTED", "StorageAdapter.read() not implemented");
  }

  /**
   * Write a collection. `data` is the serialised string to persist.
   * @param {string} name
   * @param {string} data
   * @returns {Promise<void>}
   */
  async write(name, data) {
    throw new AdapterError("ERR_SKALEX_ADAPTER_NOT_IMPLEMENTED", "StorageAdapter.write() not implemented");
  }

  /**
   * Delete a collection.
   * @param {string} name
   * @returns {Promise<void>}
   */
  async delete(name) {
    throw new AdapterError("ERR_SKALEX_ADAPTER_NOT_IMPLEMENTED", "StorageAdapter.delete() not implemented");
  }

  /**
   * List all stored collection names.
   * @returns {Promise<string[]>}
   */
  async list() {
    throw new AdapterError("ERR_SKALEX_ADAPTER_NOT_IMPLEMENTED", "StorageAdapter.list() not implemented");
  }

  /**
   * Batch write multiple collections. Default: sequential fallback.
   * Adapters that support atomic batches should override this.
   * @param {{ name: string, data: string }[]} entries
   * @returns {Promise<void>}
   */
  async writeAll(entries) {
    for (const { name, data } of entries) await this.write(name, data);
  }

  // ─── Capability checks ────────────────────────────────────────────────
  //
  // Replaces duck-typed `typeof adapter.readRaw === "function"` checks
  // throughout the engine. Subclasses override to return true when they
  // implement the corresponding optional methods.

  /** Whether this adapter supports batch writes with native atomicity. */
  get supportsBatch() { return false; }

  /** Whether this adapter supports raw file reads (readRaw). */
  get supportsRawRead() { return typeof this.readRaw === "function"; }

  /** Whether this adapter supports raw file writes (writeRaw). */
  get supportsRawWrite() { return typeof this.writeRaw === "function"; }

  /** Whether this adapter supports path operations (join, ensureDir). */
  get supportsPath() { return typeof this.join === "function" && typeof this.ensureDir === "function"; }
}

/** Async zlib wrappers - avoids node:util import that breaks browser builds. */
const _deflate = (data) => new Promise((resolve, reject) => zlib.deflate(data, (err, buf) => err ? reject(err) : resolve(buf)));
const _inflate = (data) => new Promise((resolve, reject) => zlib.inflate(data, (err, buf) => err ? reject(err) : resolve(buf)));

/**
 * FsAdapter  -  file-system storage for Node.js, Bun, and Deno.
 *
 * Files are stored as `<dir>/<name>.<format>`.
 * format="gz"  → zlib deflate compressed JSON
 * format="json" → plain JSON
 */
class FsAdapter extends StorageAdapter {
  /**
   * @param {object} opts
   * @param {string} opts.dir   - Resolved directory path
   * @param {string} [opts.format="gz"] - "gz" or "json"
   */
  constructor({ dir, format = "gz" }) {
    super();
    this.dir = nodePath.resolve(dir);
    this.format = format;
    this._ensureDir(this.dir);
  }

  _ensureDir(dir) {
    if (!nodeFs.existsSync(dir)) {
      nodeFs.mkdirSync(dir, { recursive: true });
    }
  }

  _filePath(name) {
    return nodePath.join(this.dir, `${name}.${this.format}`);
  }

  async read(name) {
    const fp = this._filePath(name);
    try {
      let raw = await nodeFs.promises.readFile(fp);
      if (this.format === "gz") {
        raw = await _inflate(raw);
      }
      return raw.toString("utf8");
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
  }

  async write(name, data) {
    const fp = this._filePath(name);
    const tmp = nodePath.join(this.dir, `${name}_${globalThis.crypto.randomUUID()}.tmp.${this.format}`);

    if (this.format === "gz") {
      const compressed = await _deflate(data);
      await nodeFs.promises.writeFile(tmp, compressed);
    } else {
      await nodeFs.promises.writeFile(tmp, data, "utf8");
    }
    await nodeFs.promises.rename(tmp, fp);
  }

  /**
   * Batch write: stage all entries to temp files, then rename atomically.
   * If any rename fails, best-effort cleanup of staged temps.
   * @param {{ name: string, data: string }[]} entries
   * @returns {Promise<void>}
   */
  async writeAll(entries) {
    // Stage phase: write all entries to temp files
    const staged = [];
    try {
      for (const { name, data } of entries) {
        const fp = this._filePath(name);
        const tmp = nodePath.join(this.dir, `${name}_${globalThis.crypto.randomUUID()}.tmp.${this.format}`);
        if (this.format === "gz") {
          const compressed = await _deflate(data);
          await nodeFs.promises.writeFile(tmp, compressed);
        } else {
          await nodeFs.promises.writeFile(tmp, data, "utf8");
        }
        staged.push({ tmp, fp });
      }

      // Commit phase: rename all temp files to final paths
      for (const { tmp, fp } of staged) {
        await nodeFs.promises.rename(tmp, fp);
      }
    } catch (error) {
      // Best-effort cleanup of staged temp files
      for (const { tmp } of staged) {
        try { await nodeFs.promises.unlink(tmp); } catch { /* ignore */ }
      }
      throw error;
    }
  }

  async delete(name) {
    const fp = this._filePath(name);
    try {
      await nodeFs.promises.unlink(fp);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }

  async list() {
    try {
      const files = await nodeFs.promises.readdir(this.dir);
      const ext = `.${this.format}`;
      return files
        .filter(f => f.endsWith(ext) && !f.includes(".tmp."))
        .map(f => f.slice(0, -ext.length));
    } catch (err) {
      if (err.code === "ENOENT") return [];
      throw err;
    }
  }

  /** Utility: join paths. */
  join(...parts) {
    return nodePath.join(...parts);
  }

  /** Utility: ensure a directory exists (used by export). */
  ensureDir(dir) {
    this._ensureDir(dir);
  }

  /** Write arbitrary content to any path (used by export). */
  async writeRaw(filePath, content) {
    this._ensureDir(nodePath.dirname(filePath));
    await nodeFs.promises.writeFile(filePath, content, "utf8");
  }

  /** Read arbitrary content from any path (used by import). */
  async readRaw(filePath) {
    return nodeFs.promises.readFile(nodePath.resolve(filePath), "utf8");
  }

  /**
   * Delete any orphan temp files left by interrupted writes.
   * Temp files are named `<name>_<uuid>.tmp.<format>` - a partial rename on
   * the way out of `write()` / `writeAll()` can leave them on disk.
   * Best-effort: individual unlink failures are ignored.
   * @returns {Promise<number>} The number of temp files removed.
   */
  async cleanOrphans() {
    try {
      const files = await nodeFs.promises.readdir(this.dir);
      const orphans = files.filter(f => f.includes(".tmp."));
      let removed = 0;
      for (const orphan of orphans) {
        const orphanPath = nodePath.join(this.dir, orphan);
        try {
          await nodeFs.promises.unlink(orphanPath);
          removed++;
        } catch { /* ignore cleanup failures */ }
      }
      return removed;
    } catch (err) {
      if (err.code === "ENOENT") return 0;
      throw err;
    }
  }
}

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

/**
 * indexes.js  -  secondary field index engine.
 *
 * Maintains Map-based indexes for declared fields.
 * - Indexed field lookups are O(1) instead of O(n).
 * - Unique indexes enforce no-duplicate constraint on insert/update.
 *
 * Index maps:
 *   fieldIndexes[field]: Map<fieldValue, Set<item>>
 *   uniqueIndexes[field]: Map<fieldValue, item>  (enforces uniqueness)
 */

/** Empty read-only iterable returned when no index match is found. */
const EMPTY_ITERABLE = { [Symbol.iterator]() { return { next() { return { done: true }; } }; }, size: 0 };

/**
 * Wrap a Set in a read-only iterable to prevent callers from mutating the backing index.
 * @param {Set} set
 * @returns {{ [Symbol.iterator]: Function, size: number }}
 */
function readOnlyIterable(set) {
  return {
    [Symbol.iterator]() { return set[Symbol.iterator](); },
    get size() { return set.size; },
  };
}

/**
 * Encode a tuple of values into a stable string key for compound indexes.
 * Type-tagged to prevent collisions across types.
 * @param {any[]} values
 * @returns {string}
 */
function encodeTuple(values) {
  return values.map(v => {
    if (v === null || v === undefined) return "\x00";
    if (typeof v === "boolean") return v ? "\x01T" : "\x01F";
    if (typeof v === "number") return `\x02${v}`;
    return `\x03${String(v)}`;
  }).join("\x1F");
}

class IndexEngine {
  /**
   * @param {(string|string[])[]} fields - Fields to index. Strings for single fields,
   *   arrays like ["field1", "field2"] for compound indexes.
   * @param {string[]} unique   - Fields with unique constraint
   */
  get [Symbol.toStringTag]() { return "IndexEngine"; }

  constructor(fields = [], unique = []) {
    this._fields = new Set();
    this._compoundFields = [];
    for (const f of fields) {
      if (Array.isArray(f)) {
        for (const subf of f) this._validateFieldName(subf);
        this._compoundFields.push(f);
      } else {
        this._validateFieldName(f);
        this._fields.add(f);
      }
    }
    for (const f of unique) this._validateFieldName(f);
    this._uniqueFields = new Set(unique);
    this._indexedFields = new Set([...this._fields, ...this._uniqueFields]);

    // fieldIndexes: Map<string, Map<any, Set<object>>>
    this._fieldIndexes = new Map();
    // uniqueIndexes: Map<string, Map<any, object>>
    this._uniqueIndexes = new Map();

    for (const f of this._fields) {
      this._fieldIndexes.set(f, new Map());
    }
    for (const f of this._uniqueFields) {
      this._uniqueIndexes.set(f, new Map());
      // Also maintain a fieldIndex for the unique field
      if (!this._fieldIndexes.has(f)) {
        this._fieldIndexes.set(f, new Map());
      }
    }

    // Compound indexes: Map<tupleKey, Set<doc>>
    // Each compound index is keyed by the fields array (stored as a joined string for Map key)
    this._compoundIndexes = new Map();
    for (const fieldSet of this._compoundFields) {
      this._compoundIndexes.set(fieldSet.join("\0"), { fields: fieldSet, map: new Map() });
    }
  }

  /** Set of all indexed field names (union of regular + unique). */
  get indexedFields() {
    return this._indexedFields;
  }

  /**
   * Build indexes from an existing data array (called on load).
   * @param {object[]} data
   */
  buildFromData(data) {
    // Reset
    for (const [, m] of this._fieldIndexes) m.clear();
    for (const [, m] of this._uniqueIndexes) m.clear();
    for (const [, ci] of this._compoundIndexes) ci.map.clear();

    for (const doc of data) {
      this._indexDoc(doc);
    }
  }

  /**
   * Add a document to all indexes.
   * Throws if a unique constraint is violated.
   * @param {object} doc
   */
  add(doc) {
    this._checkUnique(doc, null);
    this._indexDoc(doc);
  }

  /**
   * Remove a document from all indexes.
   * @param {object} doc
   */
  remove(doc) {
    for (const [field, map] of this._fieldIndexes) {
      const val = doc[field];
      if (val !== undefined) {
        const set = map.get(val);
        if (set) {
          set.delete(doc);
          if (set.size === 0) map.delete(val);
        }
      }
    }
    for (const [field, map] of this._uniqueIndexes) {
      const val = doc[field];
      if (val !== undefined) map.delete(val);
    }
    for (const [, ci] of this._compoundIndexes) {
      const tupleKey = encodeTuple(ci.fields.map(f => doc[f]));
      const set = ci.map.get(tupleKey);
      if (set) {
        set.delete(doc);
        if (set.size === 0) ci.map.delete(tupleKey);
      }
    }
  }

  /**
   * Update a document"s index entries (called after mutation).
   * Throws if a unique constraint is violated by the new values.
   * @param {object} oldDoc
   * @param {object} newDoc
   */
  update(oldDoc, newDoc) {
    this._checkUnique(newDoc, oldDoc);
    this.remove(oldDoc);
    try {
      this._indexDoc(newDoc);
    } catch (indexError) {
      // Restore old doc in the index. If restore itself fails, throw the
      // original error - the restore failure is a secondary symptom.
      try { this._indexDoc(oldDoc); } catch { /* preserve original error */ }
      throw indexError;
    }
  }

  /**
   * Find all documents where field === value. Returns array (may be empty).
   * Returns null if the field is not indexed.
   * @param {string} field
   * @param {*} value
   * @returns {object[]|null}
   */
  /**
   * Find all documents where field === value. Returns array for public API.
   * Returns null if the field is not indexed.
   * @param {string} field
   * @param {*} value
   * @returns {object[]|null}
   */
  lookup(field, value) {
    const map = this._fieldIndexes.get(field);
    if (!map) return null;
    const set = map.get(value);
    return set ? [...set] : [];
  }

  /**
   * Internal iterable lookup - avoids array materialization for internal scan paths.
   * Returns null if the field is not indexed.
   * @param {string} field
   * @param {*} value
   * @returns {Iterable|null}
   */
  _lookupIterable(field, value) {
    const map = this._fieldIndexes.get(field);
    if (!map) return null;
    const set = map.get(value);
    return set ? readOnlyIterable(set) : EMPTY_ITERABLE;
  }

  /**
   * Compound index lookup. Returns matching docs for a multi-field equality match.
   * Returns null if no compound index covers the given fields.
   * @param {Object<string, any>} fieldValues - { field1: val1, field2: val2 }
   * @returns {Iterable|null}
   */
  lookupCompound(fieldValues) {
    const keys = Object.keys(fieldValues).sort();
    for (const [, ci] of this._compoundIndexes) {
      const ciKeys = [...ci.fields].sort();
      if (ciKeys.length !== keys.length) continue;
      if (ciKeys.every((k, i) => k === keys[i])) {
        const tupleKey = encodeTuple(ci.fields.map(f => fieldValues[f]));
        const set = ci.map.get(tupleKey);
        return set ? readOnlyIterable(set) : EMPTY_ITERABLE;
      }
    }
    return null;
  }

  /**
   * Check if a value is already taken for a unique field.
   * @param {string} field
   * @param {*} value
   * @returns {boolean}
   */
  isUniqueTaken(field, value) {
    const map = this._uniqueIndexes.get(field);
    if (!map) return false;
    return map.has(value);
  }

  /**
   * Validate unique constraints for a staged batch of updates before mutating
   * any live document or index state.
   * @param {object[]} oldDocs
   * @param {object[]} newDocs
   */
  assertUniqueCandidates(oldDocs, newDocs) {
    if (this._uniqueFields.size === 0) return;

    const batchOldIds = new Set(oldDocs.map(doc => doc._id));

    for (const field of this._uniqueFields) {
      const reserved = new Set();
      const uniqueMap = this._uniqueIndexes.get(field);
      if (uniqueMap) {
        for (const [value, doc] of uniqueMap.entries()) {
          if (!batchOldIds.has(doc._id)) reserved.add(value);
        }
      }

      const seen = new Map();
      for (let i = 0; i < newDocs.length; i++) {
        const val = newDocs[i][field];
        if (val === undefined) continue;
        if (reserved.has(val)) {
          throw new UniqueConstraintError("ERR_SKALEX_UNIQUE_VIOLATION", `Unique constraint violation: field "${field}" value "${val}" already exists`, { field, value: val });
        }
        const prior = seen.get(val);
        if (prior && prior !== oldDocs[i]._id) {
          throw new UniqueConstraintError("ERR_SKALEX_UNIQUE_VIOLATION", `Unique constraint violation: field "${field}" value "${val}" already exists`, { field, value: val });
        }
        seen.set(val, oldDocs[i]._id);
      }
    }
  }

  /**
   * Preflight unique constraints for an insert batch before any index
   * mutation. Checks both against the existing index and within the batch
   * itself for intra-batch duplicates.
   * @param {object[]} newDocs
   */
  assertUniqueBatch(newDocs) {
    if (this._uniqueFields.size === 0) return;

    for (const field of this._uniqueFields) {
      const uniqueMap = this._uniqueIndexes.get(field);
      const seen = new Set();

      for (const doc of newDocs) {
        const val = doc[field];
        if (val === undefined) continue;

        if (uniqueMap && uniqueMap.has(val)) {
          throw new UniqueConstraintError(
            "ERR_SKALEX_UNIQUE_VIOLATION",
            `Unique constraint violation: field "${field}" value "${val}" already exists`,
            { field, value: val }
          );
        }
        if (seen.has(val)) {
          throw new UniqueConstraintError(
            "ERR_SKALEX_UNIQUE_VIOLATION",
            `Unique constraint violation: duplicate "${field}" value "${val}" within batch`,
            { field, value: val }
          );
        }
        seen.add(val);
      }
    }
  }

  /**
   * Reject field names containing dot-notation. The index engine uses
   * direct property access (doc[field]), not resolveDotPath(), so dot-path
   * fields produce false negatives without falling through to linear scan.
   * @param {string} field
   */
  _validateFieldName(field) {
    if (field.includes(".")) {
      throw new ValidationError(
        "ERR_SKALEX_VALIDATION_INDEX_DOT_PATH",
        `Index fields cannot use dot-notation: "${field}". Use a flat field name.`,
        { field }
      );
    }
  }

  // ─── private ─────────────────────────────────────────────────────────────

  _indexDoc(doc) {
    for (const [field, map] of this._fieldIndexes) {
      const val = doc[field];
      if (val !== undefined) {
        if (!map.has(val)) map.set(val, new Set());
        map.get(val).add(doc);
      }
    }
    for (const [field, map] of this._uniqueIndexes) {
      const val = doc[field];
      if (val !== undefined) map.set(val, doc);
    }
    for (const [, ci] of this._compoundIndexes) {
      for (const f of ci.fields) {
        const val = doc[f];
        if (val !== undefined && val !== null && typeof val === "object") {
          throw new ValidationError(
            "ERR_SKALEX_VALIDATION_COMPOUND_INDEX",
            `Compound index field "${f}" must be a scalar value (string, number, or boolean), got ${Array.isArray(val) ? "array" : typeof val}`,
            { field: f }
          );
        }
      }
      const tupleKey = encodeTuple(ci.fields.map(f => doc[f]));
      if (!ci.map.has(tupleKey)) ci.map.set(tupleKey, new Set());
      ci.map.get(tupleKey).add(doc);
    }
  }

  _checkUnique(newDoc, existingDoc) {
    for (const field of this._uniqueFields) {
      const val = newDoc[field];
      if (val === undefined) continue;
      const map = this._uniqueIndexes.get(field);
      if (!map) continue;
      const existing = map.get(val);
      // Conflict only if there is an existing doc with this value
      // and it is NOT the same document being updated.
      // Compare by _id so this is robust whether existingDoc is the original
      // object reference or a shallow copy made before mutation.
      if (existing && existing._id !== existingDoc?._id) {
        throw new UniqueConstraintError("ERR_SKALEX_UNIQUE_VIOLATION", `Unique constraint violation: field "${field}" value "${val}" already exists`, { field, value: val });
      }
    }
  }
}

/**
 * ask.js  -  query cache and LLM filter utilities for db.ask().
 */

// ─── Hash ─────────────────────────────────────────────────────────────────────

/**
 * Deterministic djb2-style hash of a string.
 * @param {string} str
 * @returns {string} 8-char hex
 */
function _djb2(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// ─── QueryCache ───────────────────────────────────────────────────────────────

/**
 * QueryCache  -  maps hash(collection + schema + query) → filter object.
 *
 * Persisted in the _meta collection so it survives connect/disconnect cycles.
 * The cache avoids calling the LLM again for the same question on the same schema.
 *
 * @param {object} [opts]
 * @param {number} [opts.maxSize=500] - Maximum number of entries. Oldest entry is evicted when full.
 * @param {number} [opts.ttl=0]      - Entry TTL in ms. 0 = no expiry.
 */
class QueryCache {
  constructor({ maxSize = 500, ttl = 0 } = {}) {
    this._cache   = new Map();
    this._maxSize = maxSize;
    this._ttl     = ttl;
  }

  _key(collectionName, schema, query) {
    return _djb2(JSON.stringify({ collectionName, schema, query }));
  }

  get(collectionName, schema, query) {
    const key   = this._key(collectionName, schema, query);
    const entry = this._cache.get(key);
    if (!entry) return undefined;
    if (this._ttl > 0 && Date.now() - entry.ts > this._ttl) {
      this._cache.delete(key);
      return undefined;
    }
    return entry.filter;
  }

  set(collectionName, schema, query, filter) {
    const key = this._key(collectionName, schema, query);
    // Evict oldest entry when at capacity (and key is new)
    if (this._cache.size >= this._maxSize && !this._cache.has(key)) {
      this._cache.delete(this._cache.keys().next().value);
    }
    this._cache.set(key, { filter, ts: Date.now() });
  }

  toJSON() {
    return Object.fromEntries(
      [...this._cache.entries()].map(([k, v]) => [k, v])
    );
  }

  fromJSON(data) {
    if (!data || typeof data !== "object") return;
    for (const [k, v] of Object.entries(data)) {
      this._cache.set(k, v);
    }
  }

  get size() {
    return this._cache.size;
  }
}

// ─── Filter helpers ───────────────────────────────────────────────────────────

/**
 * Convert an LLM-generated filter into a form matchesFilter() can execute.
 * - $regex string values → RegExp objects
 * - ISO date strings in range operators → Date objects
 *
 * @param {object} filter
 * @param {object} [opts]
 * @param {number} [opts.regexMaxLength=500] - Maximum allowed $regex pattern length.
 * @returns {object}
 */
function processLLMFilter(filter, { regexMaxLength = 500 } = {}) {
  if (typeof filter !== "object" || filter === null) return filter;

  const result = {};
  for (const key of Object.keys(filter)) {
    const val = filter[key];
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const processed = {};
      for (const op of Object.keys(val)) {
        if (op === "$regex" && typeof val.$regex === "string") {
          if (val.$regex.length > regexMaxLength)
            throw new QueryError("ERR_SKALEX_QUERY_REGEX_TOO_LONG", `$regex pattern too long (max ${regexMaxLength} characters)`);
          // Reject patterns with nested quantifiers that cause catastrophic backtracking.
          // e.g. (a+)+, (a|a)*, (x+){2,}
          if (/\([^)]*[+*][^)]*\)[+*{]/.test(val.$regex))
            throw new QueryError("ERR_SKALEX_QUERY_REGEX_REDOS", `$regex pattern rejected: nested quantifiers risk ReDoS`);
          try {
            processed.$regex = new RegExp(val.$regex);
          } catch {
            throw new QueryError("ERR_SKALEX_QUERY_REGEX_INVALID", `invalid $regex pattern: "${val.$regex}"`);
          }
        } else if (["$gt", "$gte", "$lt", "$lte"].includes(op) && _isDateString(val[op])) {
          processed[op] = new Date(val[op]);
        } else {
          processed[op] = val[op];
        }
      }
      result[key] = processed;
    } else {
      result[key] = val;
    }
  }
  return result;
}

function _isDateString(val) {
  if (typeof val !== "string") return false;
  return /\d{4}-\d{2}-\d{2}/.test(val) && !isNaN(Date.parse(val));
}

/**
 * Validate a filter generated by an LLM against a known schema.
 * Returns warning strings for unknown fields  -  does not throw.
 *
 * @param {object} filter
 * @param {object|null} schema  - Plain { field: type } schema object.
 * @returns {string[]}
 */
function validateLLMFilter(filter, schema) {
  const warnings = [];
  if (!schema || typeof filter !== "object" || filter === null) return warnings;

  for (const key of Object.keys(filter)) {
    if (key.startsWith("$")) continue;
    const baseField = key.split(".")[0];
    if (!(baseField in schema)) {
      warnings.push(`Unknown field referenced in generated filter: "${key}"`);
    }
  }

  return warnings;
}

/**
 * AI query and embedding subsystem.
 *
 * Owns the LLM adapter, embedding adapter, and query cache. Extracted from
 * `Skalex` so the main class stays a thin lifecycle facade.
 *
 * @param {object} opts
 * @param {object|null} opts.aiAdapter - Pre-built LLM adapter or null.
 * @param {object|null} opts.embeddingAdapter - Pre-built embedding adapter or null.
 * @param {object} opts.queryCacheConfig - { maxSize, ttl } for QueryCache.
 * @param {number} opts.regexMaxLength - Max $regex length for LLM filters.
 * @param {object} opts.persistence - PersistenceManager reference.
 * @param {Function} opts.getCollections - () => collections store map.
 * @param {Function} opts.getCollection - (name) => Collection instance.
 * @param {Function} opts.getSchema - (name) => schema object or null.
 * @param {Function} opts.log - Debug logger (message) => void.
 */
class SkalexAI {
  constructor({ aiAdapter, embeddingAdapter, queryCacheConfig, regexMaxLength, persistence, getCollections, getCollection, getSchema, log }) {
    this._aiAdapter = aiAdapter;
    this._embeddingAdapter = embeddingAdapter;
    this._queryCache = new QueryCache(queryCacheConfig || {});
    this._regexMaxLength = regexMaxLength ?? 500;
    this._persistence = persistence;
    this._getCollections = getCollections;
    this._getCollection = getCollection;
    this._getSchema = getSchema;
    this._log = log;
  }

  /**
   * Embed a text string using the configured embedding adapter.
   * @param {string} text
   * @returns {Promise<number[]>}
   */
  // eslint-disable-next-line require-await -- async converts sync-throw to promise-rejection for caller symmetry.
  async embed(text) {
    if (!this._embeddingAdapter) {
      throw new AdapterError(
        "ERR_SKALEX_ADAPTER_EMBEDDING_REQUIRED",
        "db.embed() requires an AI adapter. Pass { ai: { provider, apiKey } } to the Skalex constructor."
      );
    }
    return this._embeddingAdapter.embed(text);
  }

  /**
   * Natural-language query: translate `nlQuery` into a filter via the language
   * model and run it against the collection. Results are cached by query hash.
   *
   * @param {string} collectionName
   * @param {string} nlQuery
   * @param {{ limit?: number }} [opts]
   * @returns {Promise<{ docs: object[], page?: number, totalDocs?: number, totalPages?: number }>}
   */
  async ask(collectionName, nlQuery, { limit = 20 } = {}) {
    if (!this._aiAdapter) {
      throw new AdapterError(
        "ERR_SKALEX_ADAPTER_LLM_REQUIRED",
        'db.ask() requires a language model adapter. Configure { ai: { provider, model: "..." } }.'
      );
    }

    const col = this._getCollection(collectionName);
    const schema = this._getSchema(collectionName);

    // Cache lookup
    let filter = this._queryCache.get(collectionName, schema, nlQuery);
    if (!filter) {
      filter = await this._aiAdapter.generate(schema, nlQuery);
      const warnings = validateLLMFilter(filter, schema);
      if (warnings.length) warnings.forEach(w => this._log(`[ask] ${w}`));
      this._queryCache.set(collectionName, schema, nlQuery, filter);
      this._persistence.updateMeta(this._getCollections(), { queryCache: this._queryCache.toJSON() });
    }

    return col.find(processLLMFilter(filter, { regexMaxLength: this._regexMaxLength }), { limit });
  }

  /** @returns {QueryCache} */
  get queryCache() { return this._queryCache; }
}

/**
 * SkalexImporter - handles JSON file import into collections.
 *
 * Extracted from Skalex to remove filesystem-specific logic from the
 * main class.
 *
 * @param {object} opts
 * @param {object} opts.fs - Storage adapter with readRaw().
 * @param {Function} opts.getCollection - (name) => Collection instance.
 */
class SkalexImporter {
  constructor({ fs, getCollection }) {
    this._fs = fs;
    this._getCollection = getCollection;
  }

  /**
   * Import documents from a JSON file into a collection.
   * The collection name is derived from the file name (without extension).
   * @param {string} filePath - Absolute or relative path to the file.
   * @returns {Promise<Document[]>}
   */
  async import(filePath) {
    const content = await this._fs.readRaw(filePath);
    let docs;
    try {
      docs = JSON.parse(content);
    } catch {
      throw new PersistenceError("ERR_SKALEX_PERSISTENCE_INVALID_JSON", `import: invalid JSON in file "${filePath}"`, { filePath });
    }
    // Handle both forward-slash and backslash path separators (Windows).
    const name = filePath.split(/[/\\]/).pop().replace(/\.[^.]+$/, "");
    const col = this._getCollection(name);
    return col.insertMany(Array.isArray(docs) ? docs : [docs], { save: true });
  }
}

/**
 * persistence.js  -  PersistenceManager for Skalex.
 *
 * Owns all load/save orchestration, dirty tracking, write-queue coalescing,
 * flush sentinel management, and orphan temp-file cleanup.
 */

/** Key used to store persistence metadata in the _meta collection. */
const FLUSH_META_KEY = "_flush";
/** _id of the meta document inside the _meta collection. */
const META_DOC_ID = "migrations";

class PersistenceManager {
  /**
   * @param {object} opts
   * @param {import("../connectors/storage/base.js").default} opts.adapter - Storage adapter.
   * @param {Function} opts.serializer   - (value) => string
   * @param {Function} opts.deserializer - (text) => value
   * @param {Function} opts.logger       - (msg, level) => void
   * @param {boolean}  [opts.debug=false]
   */
  get [Symbol.toStringTag]() { return "PersistenceManager"; }

  constructor({ adapter, serializer, deserializer, logger, debug = false, lenientLoad = false, registry = null }) {
    this._adapter = adapter;
    this._serializer = serializer;
    this._deserializer = deserializer;
    this._logger = logger;
    this._debug = debug;
    this._lenientLoad = lenientLoad;
    /** @type {import("./registry.js").default|null} Back-reference used for canonical store construction. */
    this._registry = registry;

    /**
     * Promise-chain lock to serialize concurrent saveAtomic() calls.
     * Regular saves (save/saveDirty) do not acquire this lock - they
     * rely on per-collection coalescing in _saveOne() instead.
     */
    this._saveLock = Promise.resolve();
  }

  /**
   * Acquire the save lock, execute fn, then release.
   * @param {Function} fn - async () => void
   * @returns {Promise<void>}
   */
  _withSaveLock(fn) {
    const next = this._saveLock.then(fn);
    this._saveLock = next.catch(() => {});
    return next;
  }

  // ─── Load ──────────────────────────────────────────────────────────────

  /**
   * Load all collections from the storage adapter.
   * Detects incomplete flushes and cleans orphan temp files.
   *
   * @param {object} collections         - Live collections map (mutated in place).
   * @param {Function} parseSchema       - Schema parser.
   * @param {Function} buildIndex        - (data, keyField) => Map
   * @param {Function} IndexEngine       - IndexEngine class.
   * @returns {Promise<void>}
   */
  /** Attach the registry used for canonical store construction. */
  setRegistry(registry) {
    this._registry = registry;
  }

  async loadAll(collections, { parseSchema, buildIndex, IndexEngine }) {
    try {
      const names = await this._adapter.list();

      await Promise.all(names.map(async (name) => {
        try {
          const raw = await this._adapter.read(name);
          if (!raw) return;

          const parsed = this._deserializer(raw);
          const { collectionName, data } = parsed;
          if (!collectionName) return;

          // Prefer config from createCollection over persisted values
          const existing = collections[collectionName];
          const rawSchema = existing?.rawSchema ?? parsed.rawSchema ?? null;
          const parsedSchema = existing?.schema ?? (rawSchema ? parseSchema(rawSchema) : null);
          const changelog = existing?.changelog ?? parsed.changelog ?? false;
          const softDelete = existing?.softDelete ?? parsed.softDelete ?? false;
          const versioning = existing?.versioning ?? parsed.versioning ?? false;
          const strict = existing?.strict ?? parsed.strict ?? false;
          const onSchemaError = existing?.onSchemaError ?? parsed.onSchemaError ?? "throw";
          const defaultTtl = existing?.defaultTtl ?? parsed.defaultTtl ?? null;
          const defaultEmbed = existing?.defaultEmbed ?? parsed.defaultEmbed ?? null;
          const maxDocs = existing?.maxDocs ?? parsed.maxDocs ?? null;

          let fieldIndex = existing ? existing.fieldIndex : null;
          if (!fieldIndex && parsedSchema?.uniqueFields?.length) {
            fieldIndex = new IndexEngine([], parsedSchema.uniqueFields);
          }

          const idIndex = buildIndex(data, "_id");
          if (fieldIndex) fieldIndex.buildFromData(data);

          // Build the canonical store shape via the registry (single construction
          // path), then merge loaded data/options into it. If a new store field
          // is added to registry.createStore(), it automatically applies here too.
          if (this._registry) {
            this._registry.createStore(collectionName, {
              schema: rawSchema,
              changelog,
              softDelete,
              versioning,
              strict,
              onSchemaError,
              defaultTtl,
              defaultEmbed,
              maxDocs,
            });
            const store = this._registry.stores[collectionName];
            store.data = data;
            store.index = idIndex;
            // Preserve the index instance already built from loaded data.
            if (fieldIndex) store.fieldIndex = fieldIndex;
            collections[collectionName] = store;
          } else {
            collections[collectionName] = {
              collectionName,
              data,
              index: idIndex,
              isSaving: false,
              _pendingSave: false,
              _dirty: false,
              schema: parsedSchema,
              rawSchema,
              fieldIndex,
              changelog,
              softDelete,
              versioning,
              strict,
              onSchemaError,
              defaultTtl,
              defaultEmbed,
              maxDocs,
            };
          }
        } catch (error) {
          if (error.code === "ENOENT") return;
          if (this._lenientLoad) {
            this._logger(`WARNING: Could not load collection "${name}": ${error.message}. Collection will be empty.`, "error");
            return;
          }
          throw new PersistenceError(
            "ERR_SKALEX_PERSISTENCE_CORRUPT",
            `Failed to load collection "${name}": ${error.message}`,
            { collection: name }
          );
        }
      }));

      // Detect incomplete flush and clean orphan temp files
      this._detectIncompleteFlush(collections);
      await this._cleanOrphanTempFiles();
    } catch (error) {
      if (error.code !== "ENOENT") {
        this._logger(`Error loading data: ${error}`, "error");
        throw error;
      }
    }
  }

  // ─── Save ──────────────────────────────────────────────────────────────

  /**
   * Persist one or all collections via the storage adapter.
   *
   * Best-effort semantics: each collection is written independently via
   * Promise.all. If one collection write fails, others may have already
   * committed. For atomic multi-collection writes, use saveAtomic()
   * (called automatically by transaction commit).
   *
   * Write queue: concurrent saves for the same collection are coalesced -
   * the second caller waits until the in-flight write completes and a
   * re-save runs with the latest data.
   *
   * @param {object} collections - Live collections map.
   * @param {string} [collectionName] - If omitted, saves all collections.
   * @returns {Promise<void>}
   */
  async save(collections, collectionName) {
    if (collectionName) {
      await this._saveOne(collections, collectionName);
    } else {
      await Promise.all(Object.keys(collections).map(name => this._saveOne(collections, name)));
    }
  }

  /**
   * Persist only collections marked dirty. Resets dirty flag after save.
   * Same best-effort semantics as save() - each dirty collection is
   * written independently.
   * @param {object} collections - Live collections map.
   * @returns {Promise<void>}
   */
  async saveDirty(collections) {
    const dirtyNames = Object.keys(collections).filter(name => collections[name]._dirty);
    if (dirtyNames.length === 0) return;
    await Promise.all(dirtyNames.map(name => this._saveOne(collections, name)));
  }

  /**
   * Batch save of specific collections via writeAll().
   * Used by transactions to commit all touched collections together.
   *
   * Strategy: include _meta (with flush sentinel) in the single writeAll()
   * batch so all data and metadata go through one adapter-level operation.
   * SQL adapters (BunSQLite, D1, LibSQL) get native atomicity; FsAdapter
   * gets a narrowed failure window (sequential renames). If the batch
   * fails, the sentinel survives on disk for crash detection on next load.
   *
   * After a successful batch, the sentinel is cleared and _meta is written
   * once more. If that final write fails, the sentinel remains - which is
   * the correct "incomplete" signal.
   *
   * @param {object} collections - Live collections map.
   * @param {string[]} names - Collection names to save.
   * @returns {Promise<void>}
   */
  saveAtomic(collections, names) {
    return this._withSaveLock(async () => {
      if (names.length === 0) return;

      // Set flush sentinel in memory before serializing
      this._writeFlushSentinel(collections, names);

      // Build a single batch including _meta alongside the touched collections
      const allNames = new Set(names);
      allNames.add("_meta");

      const entries = [...allNames]
        .filter(n => collections[n])
        .map(name => ({ name, data: this._serializeCollection(collections[name]) }));

      try {
        await this._adapter.writeAll(entries);
      } catch (error) {
        throw new PersistenceError(
          "ERR_SKALEX_PERSISTENCE_FLUSH_FAILED",
          `Batch save failed during writeAll: ${error.message}`,
          { collections: names }
        );
      }

      // Batch succeeded - clear dirty flags
      for (const name of names) {
        if (collections[name]) collections[name]._dirty = false;
      }

      // Clear sentinel and persist _meta one final time.
      // If this fails, the sentinel remains on disk - correct "incomplete" signal.
      try {
        this._clearFlushSentinel(collections);
        await this._adapter.write("_meta", this._serializeCollection(collections["_meta"]));
      } catch (error) {
        this._logger(
          `WARNING: Batch data committed but sentinel clear failed: ${error.message}. ` +
          `Next load will report an incomplete flush (false positive).`,
          "error"
        );
      }
    });
  }

  /**
   * Mark a collection as dirty (needs persistence).
   * @param {object} collections
   * @param {string} name
   */
  markDirty(collections, name) {
    const col = collections[name];
    if (col) {
      col._dirty = true;
      col._statsDirty = true;
    }
  }

  // ─── Serialization ─────────────────────────────────────────────────────

  /**
   * Serialize a collection store into a persistable string.
   * @param {object} col
   * @returns {string}
   */
  _serializeCollection(col) {
    const payload = { collectionName: col.collectionName, data: col.data };
    if (col.rawSchema) payload.rawSchema = col.rawSchema;
    if (col.changelog) payload.changelog = col.changelog;
    if (col.softDelete) payload.softDelete = col.softDelete;
    if (col.versioning) payload.versioning = col.versioning;
    if (col.strict) payload.strict = col.strict;
    if (col.onSchemaError !== "throw") payload.onSchemaError = col.onSchemaError;
    if (col.defaultTtl) payload.defaultTtl = col.defaultTtl;
    if (col.defaultEmbed) payload.defaultEmbed = col.defaultEmbed;
    if (col.maxDocs) payload.maxDocs = col.maxDocs;
    return this._serializer(payload);
  }

  // ─── Private ───────────────────────────────────────────────────────────

  /**
   * Persist a single collection. Implements per-collection write coalescing:
   * if a write is in-flight, the caller is queued and resolved only after
   * the coalesced re-save completes with the latest data.
   *
   * @param {object} collections
   * @param {string} name
   * @returns {Promise<void>}
   */
  async _saveOne(collections, name) {
    const col = collections[name];
    if (!col) return;

    // Write coalescing: queue this caller behind the in-flight write.
    if (col.isSaving) {
      col._pendingSave = true;
      return new Promise((resolve, reject) => {
        (col._saveWaiters ??= []).push({ resolve, reject });
      });
    }

    col.isSaving = true;
    col._pendingSave = false;

    try {
      await this._writeCollection(name, col);
      // Re-save loop: drain any callers that arrived during the write.
      while (col._pendingSave) {
        col._pendingSave = false;
        await this._writeCollection(name, col);
      }
      this._resolveSaveWaiters(col);
    } catch (error) {
      this._rejectSaveWaiters(col, error);
      throw error;
    } finally {
      col.isSaving = false;
    }
  }

  /**
   * Execute the actual adapter write for a collection.
   * @param {string} name
   * @param {object} col
   * @returns {Promise<void>}
   */
  async _writeCollection(name, col) {
    try {
      await this._adapter.write(name, this._serializeCollection(col));
      col._dirty = false;
    } catch (error) {
      this._logger(`Error saving "${name}": ${error.message}`, "error");
      throw error;
    }
  }

  /**
   * Resolve all queued save waiters for a collection.
   * @param {object} col
   */
  _resolveSaveWaiters(col) {
    const waiters = col._saveWaiters?.splice(0) ?? [];
    for (const w of waiters) w.resolve();
  }

  /**
   * Reject all queued save waiters for a collection.
   * @param {object} col
   * @param {Error} error
   */
  _rejectSaveWaiters(col, error) {
    const waiters = col._saveWaiters?.splice(0) ?? [];
    for (const w of waiters) w.reject(error);
  }

  /**
   * Write a flush sentinel into the _meta collection before a batch save.
   * If the process crashes mid-flush, the sentinel survives and is
   * detected on the next loadAll().
   */
  _writeFlushSentinel(collections, names) {
    const meta = this._getOrCreateMeta(collections);
    meta[FLUSH_META_KEY] = {
      startedAt: new Date().toISOString(),
      collections: names,
      completedAt: null,
    };
  }

  /**
   * Clear the flush sentinel after a successful batch save.
   */
  _clearFlushSentinel(collections) {
    const meta = this._getOrCreateMeta(collections);
    if (meta[FLUSH_META_KEY]) {
      meta[FLUSH_META_KEY].completedAt = new Date().toISOString();
    }
  }

  /**
   * On load, check if a flush sentinel indicates an incomplete previous write.
   */
  _detectIncompleteFlush(collections) {
    const metaCol = collections["_meta"];
    if (!metaCol) return;
    const metaDoc = metaCol.index.get(META_DOC_ID);
    if (!metaDoc) return;
    const flush = metaDoc[FLUSH_META_KEY];
    if (!flush) return;
    if (flush.startedAt && !flush.completedAt) {
      this._logger(
        `WARNING: Incomplete flush detected (started ${flush.startedAt}, collections: ${flush.collections?.join(", ")}). Data may be inconsistent.`,
        "error"
      );
    }
  }

  /**
   * Delegate orphan temp-file cleanup to the adapter, if supported.
   * Non-FS adapters (browser LocalStorage, D1, SQLite, etc.) don't implement
   * `cleanOrphans` and this is a no-op for them.
   */
  async _cleanOrphanTempFiles() {
    if (typeof this._adapter.cleanOrphans !== "function") return;
    try {
      const removed = await this._adapter.cleanOrphans();
      if (removed > 0) this._logger(`Cleaned ${removed} orphan temp file(s) (indicates prior incomplete write)`, "warn");
    } catch { /* ignore cleanup failures */ }
  }

  /**
   * Return the canonical `_meta` document, creating the collection and the
   * document if they do not exist. The collection shape is built via the
   * registry's single `createStore()` path so it can never drift.
   * @param {object} collections - Live collections map (mutated in place).
   * @returns {object} The meta document.
   */
  _getOrCreateMeta(collections) {
    if (!collections["_meta"]) {
      if (!this._registry) {
        throw new PersistenceError(
          "ERR_SKALEX_PERSISTENCE_NO_REGISTRY",
          "PersistenceManager requires a registry to construct _meta."
        );
      }
      this._registry.createStore("_meta");
      collections["_meta"] = this._registry.stores["_meta"];
    }
    const metaCol = collections["_meta"];
    let doc = metaCol.index.get(META_DOC_ID);
    if (!doc) {
      doc = { _id: META_DOC_ID };
      metaCol.data.push(doc);
      metaCol.index.set(META_DOC_ID, doc);
    }
    return doc;
  }

  /**
   * Return the current `_meta` document content (sans `_id`), or an empty
   * object if none exists. The collection is not mutated if absent.
   * @param {object} collections - Live collections map.
   * @returns {object}
   */
  getMeta(collections) {
    const metaCol = collections["_meta"];
    if (!metaCol) return {};
    return metaCol.index.get(META_DOC_ID) || {};
  }

  /**
   * Merge the given data into the `_meta` document and mark it dirty.
   * Creates the `_meta` collection and document if needed.
   * @param {object} collections - Live collections map (mutated in place).
   * @param {object} data - Fields to merge.
   */
  updateMeta(collections, data) {
    const doc = this._getOrCreateMeta(collections);
    Object.assign(doc, data);
    this.markDirty(collections, "_meta");
  }

  _log(msg) {
    if (this._debug) this._logger(msg, "info");
  }
}

/**
 * transaction.js  -  TransactionManager for Skalex.
 *
 * Owns transaction scope, lazy snapshots, timeout/abort protection,
 * deferred side effects, and rollback.
 */

/** Default window of aborted transaction IDs retained for stale-continuation detection. */
const DEFAULT_ABORTED_ID_WINDOW = 1000;

/**
 * Matches Collection mutation method names by convention. Any public method
 * whose name starts with `insert`, `update`, `upsert`, `delete`, or equals
 * `restore` is treated as a mutation by the transaction proxy and wrapped
 * with the depth counter. Adding a new mutation method (e.g. `patchMany`,
 * `deleteBy`, `upsertWhere`) only requires following the convention - no
 * hand-maintained list to keep in sync.
 *
 * Private methods (prefixed with `_`) and reads (find, findOne, count,
 * etc.) are excluded.
 */
const _MUTATION_METHOD_PATTERN = /^(insert|update|upsert|delete)($|[A-Z])|^restore$/;

/**
 * Valid values for the `deferredEffectErrors` option. Exported so the
 * Skalex constructor and the per-transaction option path share a single
 * source of truth and neither can drift from the other.
 */
const DEFERRED_EFFECT_STRATEGIES = /** @type {const} */ (["throw", "warn", "ignore"]);

/**
 * Validate a `deferredEffectErrors` value. Throws `ValidationError` with a
 * stable code when the value is defined but not one of the supported
 * strategies. `undefined` is allowed (caller will fall back to a default).
 * @param {unknown} value
 * @param {string} source - Human-readable origin (e.g. "Skalex config", "transaction options").
 */
function validateDeferredEffectErrors(value, source) {
  if (value === undefined) return;
  if (!DEFERRED_EFFECT_STRATEGIES.includes(value)) {
    throw new ValidationError(
      "ERR_SKALEX_VALIDATION_DEFERRED_EFFECT_ERRORS",
      `Invalid deferredEffectErrors in ${source}: "${value}". Expected one of: ${DEFERRED_EFFECT_STRATEGIES.join(", ")}.`,
      { value, source }
    );
  }
}

class TransactionManager {
  /**
   * @param {object} [opts]
   * @param {number} [opts.abortedIdWindow=1000] - Max number of aborted transaction
   *   IDs retained for stale-continuation detection. Because transactions are
   *   serialised via a promise-chain lock, no live transaction can reference an
   *   ID more than this many steps behind the counter, so older IDs are pruned.
   */
  constructor({ abortedIdWindow = DEFAULT_ABORTED_ID_WINDOW } = {}) {
    this._txLock = Promise.resolve();
    /** @type {TransactionContext|null} Current active transaction context. */
    this._ctx = null;
    /** @type {Set<number>} IDs of aborted transactions - stale continuations checked against this. */
    this._abortedIds = new Set();
    /** @type {number} Monotonic per-instance transaction ID counter. */
    this._idCounter = 0;
    /** @type {number} Pruning window for _abortedIds. */
    this._abortedIdWindow = abortedIdWindow;
  }

  get [Symbol.toStringTag]() { return "TransactionManager"; }

  /** Whether a transaction is currently active. */
  get active() {
    return this._ctx !== null && !this._ctx.aborted;
  }

  /** The current transaction context (or null). */
  get context() {
    return this._ctx;
  }

  /**
   * Run a callback inside a transaction.
   *
   * Lazy snapshots: only collections touched by a write are snapshotted,
   * on first mutation - not all collections upfront.
   *
   * @param {Function} fn            - (proxy) => Promise<any>
   * @param {object}   db            - The Skalex instance.
   * @param {object}   opts
   * @param {number}   [opts.timeout] - Max ms before abort. 0 = no timeout.
   * @param {"throw"|"warn"|"ignore"} [opts.deferredEffectErrors]
   *   Override the Skalex-instance default for this transaction only. See
   *   `SkalexConfig.deferredEffectErrors`. When omitted, falls back to
   *   `db._deferredEffectErrors` then to `"warn"`.
   * @returns {Promise<any>}
   */
  // eslint-disable-next-line require-await -- async wraps synchronous validation throws as promise rejections.
  async run(fn, db, { timeout = 0, deferredEffectErrors } = {}) {
    validateDeferredEffectErrors(deferredEffectErrors, "transaction() options");
    const execute = async () => {
      await db._ensureConnected();

      // Track which collections existed before the transaction
      const preExisting = new Set(Object.keys(db.collections));

      const ctx = {
        id: ++this._idCounter,
        startedAt: Date.now(),
        aborted: false,
        preExisting,
        touchedCollections: new Set(),
        snapshots: new Map(),
        deferredEffects: [],
        timeout,
      };

      this._ctx = ctx;

      // Timeout mechanism
      let timer = null;
      const timeoutPromise = timeout > 0
        ? new Promise((_resolve, reject) => {
          timer = setTimeout(() => {
            ctx.aborted = true;
            reject(new TransactionError(
              "ERR_SKALEX_TX_TIMEOUT",
              `Transaction ${ctx.id} timed out after ${timeout}ms`
            ));
          }, timeout);
        })
        : null;

      // Proxy to intercept direct collections access and brand with txId.
      // useCollection calls through the proxy stamp the returned Collection
      // with _activeTxId so pipeline/collection can distinguish transactional
      // from non-transactional writes. Liveness check prevents stale proxy use.
      const self = this;
      const proxy = new Proxy(db, {
        get(target, prop) {
          if (prop === "_txId") return ctx.id;
          if (ctx !== self._ctx) {
            throw new TransactionError(
              "ERR_SKALEX_TX_STALE_PROXY",
              `Transaction ${ctx.id} has ended. This proxy is no longer usable.`
            );
          }
          if (prop === "collections") throw new TransactionError(
            "ERR_SKALEX_TX_DIRECT_ACCESS",
            "Direct access to db.collections inside transaction() is not covered by rollback. Use the collection API (db.useCollection) instead."
          );
          if (prop === "useCollection") {
            return (name) => {
              const col = target.useCollection(name);
              col._activeTxId = ctx.id;
              // Return a Proxy of the Collection that marks each method
              // call as originating from the tx proxy. This lets the
              // pipeline distinguish tx writes from non-tx writes on the
              // same shared Collection instance.
              // Wrap the Collection in a Proxy that increments a depth
              // counter on mutation methods only. The pipeline checks this
              // counter to distinguish tx-proxy writes from non-tx writes
              // on the same shared Collection singleton.
              //
              // Only mutation methods are wrapped because reads (find,
              // findOne, count, etc.) do not go through the pipeline and
              // should not elevate the counter. If reads were wrapped, a
              // plugin-triggered non-tx write during a tx-proxy find()
              // would bypass the collection lock.
              return new Proxy(col, {
                get(colTarget, colProp) {
                  const v = Reflect.get(colTarget, colProp);
                  if (typeof v !== "function") return v;
                  if (typeof colProp !== "string" || !_MUTATION_METHOD_PATTERN.test(colProp)) return v.bind(colTarget);
                  return function (...args) {
                    colTarget._txProxyCallDepth = (colTarget._txProxyCallDepth || 0) + 1;
                    try {
                      const result = v.apply(colTarget, args);
                      if (result && typeof result.then === "function") {
                        return result.finally(() => { colTarget._txProxyCallDepth--; });
                      }
                      colTarget._txProxyCallDepth--;
                      return result;
                    } catch (e) {
                      colTarget._txProxyCallDepth--;
                      throw e;
                    }
                  };
                },
              });
            };
          }
          const value = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });

      /** Set after saveAtomic() succeeds. Errors after this point must NOT trigger rollback. */
      let committed = false;
      /** Result of fn(), captured so we can return it after post-commit work. */
      let result;
      /** Populated by the post-commit deferred-effect flush. */
      const deferredErrors = [];
      try {
        const fnPromise = fn(proxy);
        result = timeoutPromise
          ? await Promise.race([fnPromise, timeoutPromise])
          : await fnPromise;

        if (ctx.aborted) {
          throw new TransactionError("ERR_SKALEX_TX_ABORTED", `Transaction ${ctx.id} was aborted`);
        }

        // Commit: persist only touched collections
        const touched = [...ctx.touchedCollections];
        if (touched.length > 0) {
          await db._persistence.saveAtomic(db.collections, touched);
        }
        committed = true;

        // Flush deferred side effects after successful commit. All effects
        // run regardless of individual failures; the configured error
        // strategy decides what happens to captured errors afterwards.
        for (const effect of ctx.deferredEffects) {
          try {
            await effect();
          } catch (effectError) {
            deferredErrors.push(effectError);
          }
        }
      } catch (error) {
        // Errors during fn() or saveAtomic() trigger rollback.
        if (committed) {
          // Shouldn't happen - all post-commit work is outside this try.
          throw error;
        }
        // Rollback: restore snapshotted pre-existing collections
        for (const [name, snap] of ctx.snapshots) {
          if (ctx.preExisting.has(name)) {
            db._applySnapshot(name, snap);
            // Restore the dirty flag to its pre-transaction state
            if (db.collections[name]) db.collections[name]._dirty = snap._dirty;
          }
        }
        // Remove ALL collections that didn't exist before the transaction
        for (const name in db.collections) {
          if (!ctx.preExisting.has(name)) {
            delete db.collections[name];
            delete db._collectionInstances[name];
            if (db._registry?._statsCache) db._registry._statsCache.delete(name);
          }
        }
        // Clear stats cache for rolled-back collections so stale sizes
        // don't survive the rollback.
        for (const name of ctx.touchedCollections) {
          if (db._registry?._statsCache) db._registry._statsCache.delete(name);
        }

        throw error;
      } finally {
        if (timer) clearTimeout(timer);
        // Always clear context. Stale async continuations are caught by
        // assertNotAborted() via _abortedIds, not by leaving _ctx set.
        if (ctx.aborted) this._abortedIds.add(ctx.id);
        this._ctx = null;
        this._pruneAbortedIds();

        // Clear tx stamps on any cached Collection instances so they are
        // not permanently poisoned after the transaction ends.
        for (const name in db._collectionInstances) {
          const inst = db._collectionInstances[name];
          if (inst._createdInTxId === ctx.id) inst._createdInTxId = null;
          if (inst._activeTxId === ctx.id) inst._activeTxId = null;
        }
      }

      // Post-commit: handle deferred effect errors according to strategy.
      // Runs only if we reached commit; rollback paths skip this.
      if (deferredErrors.length > 0) {
        // Precedence: per-transaction option → Skalex instance default → "warn".
        const strategy = deferredEffectErrors ?? db._deferredEffectErrors ?? "warn";
        if (strategy === "throw") {
          throw new AggregateError(
            deferredErrors,
            `Deferred effect failures after commit of transaction ${ctx.id} (${deferredErrors.length})`
          );
        }
        if (strategy === "warn") {
          for (const e of deferredErrors) {
            db._logger(`[tx ${ctx.id}] deferred effect failed: ${e.message}`, "warn");
          }
        }
        // "ignore" - swallow silently
      }

      return result;
    };

    // Serialise concurrent transactions via promise-chain lock
    const next = this._txLock.then(execute);
    this._txLock = next.catch(() => { });
    return next;
  }

  /**
   * Lazily snapshot a collection on first write within the transaction.
   * Must be called by every mutating code path before touching state.
   *
   * @param {string} name
   * @param {object} col - The collection store object.
   * @param {Function} snapshotFn - (col) => { data, index }
   */
  snapshotIfNeeded(name, col, snapshotFn) {
    const ctx = this._ctx;
    if (!ctx) return;

    this._assertCtxNotAborted(ctx);

    if (!ctx.snapshots.has(name)) {
      const snap = snapshotFn(col);
      snap._dirty = col._dirty ?? false;
      ctx.snapshots.set(name, snap);
    }
    ctx.touchedCollections.add(name);
  }

  /**
   * Check whether a collection is currently locked by an active transaction.
   * A collection is locked from the moment it receives its first transactional
   * write (snapshotIfNeeded) until the transaction commits or rolls back.
   *
   * @param {string} name - Collection name.
   * @returns {boolean}
   */
  isCollectionLocked(name) {
    const ctx = this._ctx;
    return ctx !== null && !ctx.aborted && ctx.touchedCollections.has(name);
  }

  /**
   * Assert the current transaction has not been aborted.
   * No-op when called outside a transaction - only active transactions
   * are checked, so non-transactional writes are never blocked.
   * @throws {TransactionError} if aborted
   */
  assertNotAborted() {
    const ctx = this._ctx;
    if (ctx) this._assertCtxNotAborted(ctx);
  }

  /**
   * Check if a specific context is aborted, or if a stale continuation
   * from a previously aborted transaction is trying to mutate.
   * @param {object} ctx
   */
  _assertCtxNotAborted(ctx) {
    if (ctx.aborted) {
      throw new TransactionError(
        "ERR_SKALEX_TX_ABORTED",
        `Transaction ${ctx.id} was aborted. No further mutations allowed.`
      );
    }
  }

  /**
   * Prune aborted transaction IDs that can no longer produce stale continuations.
   * Transactions are serialised, so any ID below `counter - abortedIdWindow`
   * is unreachable from the currently live transaction.
   */
  _pruneAbortedIds() {
    if (this._abortedIds.size === 0) return;
    const cutoff = this._idCounter - this._abortedIdWindow;
    if (cutoff <= 0) return;
    for (const id of this._abortedIds) {
      if (id <= cutoff) this._abortedIds.delete(id);
    }
  }

  /**
   * Queue a side effect for after-commit execution.
   * If not in a transaction, executes immediately.
   * @param {Function} effect - async () => void
   * @returns {boolean} true if deferred, false if executed immediately
   */
  defer(effect) {
    if (this._ctx) {
      this._ctx.deferredEffects.push(effect);
      return true;
    }
    return false;
  }
}

/**
 * registry.js  -  CollectionRegistry for Skalex.
 *
 * Owns collection definitions, store creation, instance caching,
 * renames, inspection, and metadata access.
 */

/**
 * Pattern for a safe collection name. Guards against path traversal and
 * filesystem-hostile characters when the name is used as a file basename.
 * Allows letters, digits, underscore, dot, dash, and colon after the first
 * character. Max length 64.
 */
const _COLLECTION_NAME_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_.:-]{0,63}$/;

function _assertCollectionName(name) {
  if (typeof name !== "string" || !_COLLECTION_NAME_RE.test(name)) {
    throw new ValidationError(
      "ERR_SKALEX_VALIDATION_COLLECTION_NAME",
      `Invalid collection name "${name}". Names must be 1-64 characters, start with a letter, digit, or underscore, and contain only letters, digits, and "_.:-".`,
      { name }
    );
  }
}

class CollectionRegistry {
  /**
   * @param {Function} CollectionClass - The Collection constructor.
   */
  constructor(CollectionClass) {
    this._CollectionClass = CollectionClass;
    /** @type {Object<string, object>} Collection stores keyed by name. */
    this.stores = {};
    /** @type {Object<string, import("./collection.js").default>} Cached Collection instances. */
    this._instances = {};
    /** @type {Map<string, { result: object, _snapshotLen: number }>} Cached stats per collection. */
    this._statsCache = new Map();
  }

  /**
   * Get (or lazily create) a Collection instance by name.
   * @param {string} name
   * @param {object} db - The Skalex instance (passed to Collection constructor).
   * @returns {import("./collection.js").default}
   */
  get(name, db) {
    _assertCollectionName(name);
    if (this._instances[name]) return this._instances[name];
    if (!this.stores[name]) this.createStore(name);
    const instance = new this._CollectionClass(this.stores[name], db);
    this._instances[name] = instance;
    return instance;
  }

  /**
   * Define a collection with optional schema, indexes, and behaviour options.
   * @param {string} name
   * @param {object} [options]
   * @param {object} db - The Skalex instance.
   * @returns {import("./collection.js").default}
   */
  create(name, options = {}, db) {
    _assertCollectionName(name);
    this.createStore(name, options);
    const instance = new this._CollectionClass(this.stores[name], db);
    this._instances[name] = instance;
    return instance;
  }

  /**
   * Create the internal store object for a collection.
   */
  createStore(name, {
    schema,
    indexes = [],
    changelog = false,
    softDelete = false,
    versioning = false,
    strict = false,
    onSchemaError = "throw",
    defaultTtl = null,
    defaultEmbed = null,
    maxDocs = null,
  } = {}) {
    _assertCollectionName(name);
    let parsedSchema = null;
    let fieldIndex = null;

    if (schema) {
      parsedSchema = parseSchema(schema);
      const uniqueFields = parsedSchema.uniqueFields;
      if (indexes.length || uniqueFields.length) {
        fieldIndex = new IndexEngine(indexes, uniqueFields);
      }
    } else if (indexes.length) {
      fieldIndex = new IndexEngine(indexes, []);
    }

    this.stores[name] = {
      collectionName: name,
      data: [],
      index: new Map(),
      isSaving: false,
      _pendingSave: false,
      _dirty: false,
      schema: parsedSchema,
      rawSchema: schema || null,
      fieldIndex,
      changelog,
      softDelete,
      versioning,
      strict,
      onSchemaError,
      defaultTtl,
      defaultEmbed,
      maxDocs,
    };
  }

  /**
   * Rename a collection in-memory.
   * @param {string} from
   * @param {string} to
   */
  rename(from, to) {
    if (!this.stores[from]) throw new PersistenceError("ERR_SKALEX_PERSISTENCE_COLLECTION_NOT_FOUND", `Collection "${from}" not found`, { collection: from });
    if (this.stores[to]) throw new PersistenceError("ERR_SKALEX_PERSISTENCE_COLLECTION_EXISTS", `Collection "${to}" already exists`, { collection: to });

    const store = this.stores[from];
    store.collectionName = to;
    this.stores[to] = store;
    delete this.stores[from];

    if (this._instances[from]) {
      const inst = this._instances[from];
      inst.name = to;
      this._instances[to] = inst;
      delete this._instances[from];
    }
  }

  /**
   * Build a Map index from a data array.
   * @param {object[]} data
   * @param {string} keyField
   * @returns {Map}
   */
  buildIndex(data, keyField) {
    const index = new Map();
    for (const item of data) index.set(item[keyField], item);
    return index;
  }

  /**
   * Return metadata about one or all collections.
   * @param {string} [name]
   * @returns {object|null}
   */
  inspect(name) {
    if (name) {
      const col = this.stores[name];
      if (!col) return null;
      return {
        name,
        count: col.data.length,
        schema: col.schema ? Object.fromEntries(col.schema.fields) : null,
        indexes: col.fieldIndex ? [...col.fieldIndex.indexedFields] : [],
        softDelete: col.softDelete ?? false,
        versioning: col.versioning ?? false,
        strict: col.strict ?? false,
        onSchemaError: col.onSchemaError ?? "throw",
        maxDocs: col.maxDocs ?? null,
      };
    }
    const result = {};
    for (const n in this.stores) result[n] = this.inspect(n);
    return result;
  }

  /**
   * Return a snapshot of all collection data (excluding internal collections).
   * @returns {object}
   */
  dump() {
    const result = {};
    for (const name in this.stores) {
      if (!name.startsWith("_")) result[name] = structuredClone(this.stores[name].data);
    }
    return result;
  }

  /**
   * Return the schema for a collection.
   * @param {string} name
   * @returns {object|null}
   */
  schema(name) {
    const store = this.stores[name];
    if (!store) return null;
    if (store.schema) {
      return Object.fromEntries(
        [...store.schema.fields.entries()].map(([k, v]) => [k, v.type])
      );
    }
    if (store.data.length > 0) return inferSchema(store.data[0]);
    return null;
  }

  /**
   * Return size statistics for one or all collections.
   * @param {string} [name]
   * @returns {object|object[]}
   */
  stats(name) {
    const calc = (n) => {
      const col = this.stores[n];
      if (!col) return null;

      // Return cached stats if the collection has not been mutated since
      // the last computation. The _dirty flag is set by PersistenceManager
      // on every write, and cleared after a successful save. We use a
      // separate _statsDirty flag so stats invalidation is decoupled from
      // persistence state.
      const cached = this._statsCache.get(n);
      if (cached && cached._snapshotLen === col.data.length && !col._statsDirty) {
        return cached.result;
      }

      const count = col.data.length;
      let estimatedSize = 0;
      for (const doc of col.data) {
        try { estimatedSize += JSON.stringify(doc).length; } catch (_) { }
      }
      const result = { collection: n, count, estimatedSize, avgDocSize: count > 0 ? Math.round(estimatedSize / count) : 0 };
      this._statsCache.set(n, { result, _snapshotLen: count });
      col._statsDirty = false;
      return result;
    };
    if (name) return calc(name);
    return Object.keys(this.stores).map(calc);
  }

  /**
   * Clear all stores and instances.
   */
  clear() {
    this.stores = {};
    this._instances = {};
    this._statsCache.clear();
  }
}

/**
 * EmbeddingAdapter  -  interface all embedding backends must implement.
 *
 * embed(text) takes a string and returns a numeric vector (number[]).
 * Vectors are stored inline on documents as the `_vector` field and are
 * stripped from all query results so callers never see them directly.
 */
class EmbeddingAdapter {
  /**
   * Embed a text string into a numeric vector.
   * @param {string} text
   * @returns {Promise<number[]>}
   */
  async embed(text) {
    throw new AdapterError("ERR_SKALEX_ADAPTER_NOT_IMPLEMENTED", "EmbeddingAdapter.embed() not implemented");
  }
}

/**
 * fetch.js - shared fetch-with-retry utility for all AI adapters.
 *
 * Centralises retry/timeout/exponential-backoff logic so each adapter
 * only defines its URL, headers, and response handling. Zero runtime
 * dependencies - uses globalThis.fetch and AbortController.
 */

/**
 * Fetch a URL with retry, timeout, and exponential backoff.
 *
 * @param {string} url
 * @param {RequestInit} options - Standard fetch options (method, headers, body, etc.).
 * @param {object} [retryOpts]
 * @param {number} [retryOpts.retries=0] - Number of retry attempts. 0 = no retries.
 * @param {number} [retryOpts.retryDelay=1000] - Base delay in ms (doubles each attempt).
 * @param {number|null} [retryOpts.timeout=null] - Per-request timeout in ms. null = no timeout.
 * @param {typeof globalThis.fetch} [retryOpts.fetchFn=globalThis.fetch] - Fetch implementation (for testing).
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url, options, { retries = 0, retryDelay = 1000, timeout = null, fetchFn = globalThis.fetch } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = timeout != null ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeout) : null;
    try {
      const response = await fetchFn(url, {
        ...options,
        ...(controller && { signal: controller.signal }),
      });
      return response;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, retryDelay * 2 ** attempt));
      }
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }
  throw lastErr;
}

/**
 * OpenAIEmbeddingAdapter  -  generates embeddings via the OpenAI API.
 *
 * Default model: text-embedding-3-small (1536 dimensions, fast and cheap).
 * Requires Node >=18 / Bun / Deno / browser (uses native fetch).
 *
 * Environment variables (all optional  -  constructor config takes precedence):
 *   OPENAI_API_KEY            -  API key
 *   OPENAI_EMBED_MODEL        -  embedding model name
 *   OPENAI_EMBED_BASE_URL     -  full endpoint URL (useful for proxies / OpenAI-compatible APIs)
 *   OPENAI_EMBED_DIMENSIONS   -  output vector dimensions (text-embedding-3-* only)
 *   OPENAI_ORGANIZATION       -  OpenAI organization ID
 *   OPENAI_EMBED_TIMEOUT      -  request timeout in ms
 *   OPENAI_EMBED_RETRIES      -  number of retry attempts on failure (default: 0)
 *   OPENAI_EMBED_RETRY_DELAY  -  base retry delay in ms, doubles each attempt (default: 1000)
 */

const _env$4 = k => globalThis.process?.env?.[k] ?? globalThis.Deno?.env?.get(k);

class OpenAIEmbeddingAdapter extends EmbeddingAdapter {
  /**
   * @param {object}   [config]
   * @param {string}   [config.apiKey]       - OpenAI API key. Falls back to OPENAI_API_KEY env var.
   * @param {string}   [config.model]        - Embedding model. Default: "text-embedding-3-small". Falls back to OPENAI_EMBED_MODEL env var.
   * @param {string}   [config.baseUrl]      - API endpoint. Default: "https://api.openai.com/v1/embeddings". Falls back to OPENAI_EMBED_BASE_URL env var.
   * @param {number}   [config.dimensions]   - Output vector dimensions (text-embedding-3-* only). Falls back to OPENAI_EMBED_DIMENSIONS env var.
   * @param {string}   [config.organization] - OpenAI organization ID. Falls back to OPENAI_ORGANIZATION env var.
   * @param {number}   [config.timeout]      - Request timeout in ms. Falls back to OPENAI_EMBED_TIMEOUT env var.
   * @param {number}   [config.retries]      - Retry attempts on failure. Default: 0. Falls back to OPENAI_EMBED_RETRIES env var.
   * @param {number}   [config.retryDelay]   - Base retry delay in ms (doubles each attempt). Default: 1000. Falls back to OPENAI_EMBED_RETRY_DELAY env var.
   * @param {object}   [config.headers]      - Custom headers merged into every request.
   * @param {Function} [config.fetch]        - Custom fetch implementation. Default: globalThis.fetch.
   */
  constructor({
    apiKey       = _env$4("OPENAI_API_KEY"),
    model        = _env$4("OPENAI_EMBED_MODEL")      ?? "text-embedding-3-small",
    baseUrl      = _env$4("OPENAI_EMBED_BASE_URL")   ?? "https://api.openai.com/v1/embeddings",
    dimensions   = _env$4("OPENAI_EMBED_DIMENSIONS") != null ? Number(_env$4("OPENAI_EMBED_DIMENSIONS")) : undefined,
    organization = _env$4("OPENAI_ORGANIZATION")     ?? undefined,
    timeout      = _env$4("OPENAI_EMBED_TIMEOUT")    != null ? Number(_env$4("OPENAI_EMBED_TIMEOUT"))    : undefined,
    retries      = Number(_env$4("OPENAI_EMBED_RETRIES")      ?? 0),
    retryDelay   = Number(_env$4("OPENAI_EMBED_RETRY_DELAY")  ?? 1000),
    headers      = {},
    fetch: fetchFn = globalThis.fetch,
  } = {}) {
    super();
    if (!apiKey) throw new AdapterError("ERR_SKALEX_ADAPTER_MISSING_API_KEY", "OpenAIEmbeddingAdapter requires an apiKey");
    this.apiKey       = apiKey;
    this.model        = model;
    this.baseUrl      = baseUrl;
    this.dimensions   = dimensions;
    this.organization = organization;
    this.timeout      = timeout;
    this.retries      = retries;
    this.retryDelay   = retryDelay;
    this.headers      = headers;
    this._fetch       = fetchFn;
  }

  async embed(text) {
    const response = await fetchWithRetry(this.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
        ...(this.organization && { "OpenAI-Organization": this.organization }),
        ...this.headers,
      },
      body: JSON.stringify({
        input: text,
        model: this.model,
        ...(this.dimensions !== undefined && { dimensions: this.dimensions }),
      }),
    }, { retries: this.retries, retryDelay: this.retryDelay, timeout: this.timeout, fetchFn: this._fetch });
    if (!response.ok) {
      const err = (await response.text()).slice(0, 200);
      throw new AdapterError("ERR_SKALEX_ADAPTER_HTTP", `OpenAI embedding API error ${response.status}: ${err}`, { status: response.status, adapter: "openai-embedding" });
    }
    const data = await response.json();
    return data.data[0].embedding;
  }
}

/**
 * OllamaEmbeddingAdapter  -  generates embeddings via a local Ollama server.
 *
 * Default model: nomic-embed-text (768 dimensions).
 * Default host:  http://localhost:11434
 *
 * Run locally with: ollama pull nomic-embed-text
 *
 * Environment variables (all optional  -  constructor config takes precedence):
 *   OLLAMA_HOST              -  Ollama server URL
 *   OLLAMA_EMBED_MODEL       -  embedding model name
 *   OLLAMA_EMBED_TIMEOUT     -  request timeout in ms
 *   OLLAMA_EMBED_RETRIES     -  number of retry attempts on failure (default: 0)
 *   OLLAMA_EMBED_RETRY_DELAY  -  base retry delay in ms, doubles each attempt (default: 1000)
 */

const _env$3 = k => globalThis.process?.env?.[k] ?? globalThis.Deno?.env?.get(k);

class OllamaEmbeddingAdapter extends EmbeddingAdapter {
  /**
   * @param {object}   [config]
   * @param {string}   [config.model]      - Ollama model name. Default: "nomic-embed-text". Falls back to OLLAMA_EMBED_MODEL env var.
   * @param {string}   [config.host]       - Ollama server URL. Default: "http://localhost:11434". Falls back to OLLAMA_HOST env var.
   * @param {number}   [config.timeout]    - Request timeout in ms. Falls back to OLLAMA_EMBED_TIMEOUT env var.
   * @param {number}   [config.retries]    - Retry attempts on failure. Default: 0. Falls back to OLLAMA_EMBED_RETRIES env var.
   * @param {number}   [config.retryDelay] - Base retry delay in ms (doubles each attempt). Default: 1000. Falls back to OLLAMA_EMBED_RETRY_DELAY env var.
   * @param {object}   [config.headers]    - Custom headers merged into every request.
   * @param {Function} [config.fetch]      - Custom fetch implementation. Default: globalThis.fetch.
   */
  constructor({
    model      = _env$3("OLLAMA_EMBED_MODEL")       ?? "nomic-embed-text",
    host       = _env$3("OLLAMA_HOST")              ?? "http://localhost:11434",
    timeout    = _env$3("OLLAMA_EMBED_TIMEOUT")     != null ? Number(_env$3("OLLAMA_EMBED_TIMEOUT"))     : undefined,
    retries    = Number(_env$3("OLLAMA_EMBED_RETRIES")      ?? 0),
    retryDelay = Number(_env$3("OLLAMA_EMBED_RETRY_DELAY")  ?? 1000),
    headers    = {},
    fetch: fetchFn = globalThis.fetch,
  } = {}) {
    super();
    this.model      = model;
    this.host       = host;
    this.timeout    = timeout;
    this.retries    = retries;
    this.retryDelay = retryDelay;
    this.headers    = headers;
    this._fetch     = fetchFn;
  }

  async embed(text) {
    const response = await fetchWithRetry(`${this.host}/api/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.headers,
      },
      body: JSON.stringify({ model: this.model, prompt: text }),
    }, { retries: this.retries, retryDelay: this.retryDelay, timeout: this.timeout, fetchFn: this._fetch });
    if (!response.ok) {
      const err = (await response.text()).slice(0, 200);
      throw new AdapterError("ERR_SKALEX_ADAPTER_HTTP", `Ollama embedding API error ${response.status}: ${err}`, { status: response.status, adapter: "ollama-embedding" });
    }
    const data = await response.json();
    return data.embedding;
  }
}

/**
 * LLMAdapter  -  interface all language model backends must implement.
 *
 * Used by:
 *   - db.ask(question, collection)   -  NL → filter translation
 *   - memory.compress()              -  memory summarisation
 */
class LLMAdapter {
  /**
   * Translate a natural language query into a Skalex filter object.
   * @param {object} schema   - Plain { field: type } schema of the target collection.
   * @param {string} nlQuery  - Natural language query string.
   * @returns {Promise<object>} A filter object compatible with matchesFilter().
   */
  async generate(schema, nlQuery) {
    throw new AdapterError("ERR_SKALEX_ADAPTER_NOT_IMPLEMENTED", "LLMAdapter.generate() not implemented");
  }

  /**
   * Summarise multiple memory text entries into a single paragraph.
   * @param {string} texts  - Newline-separated memory entries.
   * @returns {Promise<string>}
   */
  async summarize(texts) {
    throw new AdapterError("ERR_SKALEX_ADAPTER_NOT_IMPLEMENTED", "LLMAdapter.summarize() not implemented");
  }
}

const SYSTEM_GENERATE = `You are a database query assistant. Convert the user's natural language request into a JSON filter object for a document database.

Rules:
- Return ONLY a valid JSON object, nothing else
- Use standard query operators: $eq, $ne, $gt, $gte, $lt, $lte, $in, $nin, $regex
- For simple equality, use plain key-value pairs: {"field": "value"}
- For numeric comparisons use operators: {"age": {"$gt": 18}}
- For text search use $regex: {"name": {"$regex": "pattern"}}
- Return {} to match all documents
- No explanations, no markdown, no code fences`;

const SYSTEM_SUMMARIZE = "Summarise the following memory entries into one concise paragraph. Preserve all important facts.";

/**
 * OpenAILLMAdapter  -  language model adapter using the OpenAI Chat API.
 *
 * Default model: gpt-4o-mini (fast, cheap, supports JSON mode).
 * Uses native fetch  -  no additional dependencies.
 *
 * Environment variables (all optional  -  constructor config takes precedence):
 *   OPENAI_API_KEY       -  API key
 *   OPENAI_MODEL         -  chat model name
 *   OPENAI_BASE_URL      -  full endpoint URL (useful for proxies / OpenAI-compatible APIs)
 *   OPENAI_MAX_TOKENS    -  max tokens for responses
 *   OPENAI_TEMPERATURE   -  sampling temperature for summarize() (default: 0.3)
 *   OPENAI_TOP_P         -  nucleus sampling for summarize()
 *   OPENAI_ORGANIZATION  -  OpenAI organization ID
 *   OPENAI_TIMEOUT       -  request timeout in ms
 *   OPENAI_RETRIES       -  number of retry attempts on failure (default: 0)
 *   OPENAI_RETRY_DELAY   -  base retry delay in ms, doubles each attempt (default: 1000)
 *   OPENAI_SEED          -  seed for deterministic outputs
 */

const _env$2 = k => globalThis.process?.env?.[k] ?? globalThis.Deno?.env?.get(k);

class OpenAILLMAdapter extends LLMAdapter {
  /**
   * @param {object} [config]
   * @param {string}   [config.apiKey]       - OpenAI API key. Falls back to OPENAI_API_KEY env var.
   * @param {string}   [config.model]        - Chat model. Default: "gpt-4o-mini". Falls back to OPENAI_MODEL env var.
   * @param {string}   [config.baseUrl]      - API endpoint. Default: "https://api.openai.com/v1/chat/completions". Falls back to OPENAI_BASE_URL env var.
   * @param {number}   [config.maxTokens]    - Max tokens for responses. Falls back to OPENAI_MAX_TOKENS env var.
   * @param {number}   [config.temperature]  - Sampling temperature for summarize(). Default: 0.3. generate() always uses 0. Falls back to OPENAI_TEMPERATURE env var.
   * @param {number}   [config.topP]         - Nucleus sampling for summarize(). Falls back to OPENAI_TOP_P env var.
   * @param {string}   [config.organization] - OpenAI organization ID. Falls back to OPENAI_ORGANIZATION env var.
   * @param {number}   [config.timeout]      - Request timeout in ms. Falls back to OPENAI_TIMEOUT env var.
   * @param {number}   [config.retries]         - Retry attempts on failure. Default: 0. Falls back to OPENAI_RETRIES env var.
   * @param {number}   [config.retryDelay]      - Base retry delay in ms (doubles each attempt). Default: 1000. Falls back to OPENAI_RETRY_DELAY env var.
   * @param {object}   [config.headers]         - Custom headers merged into every request.
   * @param {Function} [config.fetch]           - Custom fetch implementation. Default: globalThis.fetch.
   * @param {number}   [config.seed]            - Seed for deterministic outputs. Falls back to OPENAI_SEED env var.
   * @param {string}   [config.generatePrompt]  - System prompt for generate(). Defaults to built-in query-assistant prompt. Schema is always appended.
   * @param {string}   [config.summarizePrompt] - System prompt for summarize(). Defaults to built-in summarization prompt.
   */
  constructor({
    apiKey          = _env$2("OPENAI_API_KEY"),
    model           = _env$2("OPENAI_MODEL")        ?? "gpt-4o-mini",
    baseUrl         = _env$2("OPENAI_BASE_URL")     ?? "https://api.openai.com/v1/chat/completions",
    maxTokens       = _env$2("OPENAI_MAX_TOKENS")   != null ? Number(_env$2("OPENAI_MAX_TOKENS"))   : undefined,
    temperature     = Number(_env$2("OPENAI_TEMPERATURE") ?? 0.3),
    topP            = _env$2("OPENAI_TOP_P")        != null ? Number(_env$2("OPENAI_TOP_P"))        : undefined,
    organization    = _env$2("OPENAI_ORGANIZATION") ?? undefined,
    timeout         = _env$2("OPENAI_TIMEOUT")      != null ? Number(_env$2("OPENAI_TIMEOUT"))      : undefined,
    retries         = Number(_env$2("OPENAI_RETRIES")     ?? 0),
    retryDelay      = Number(_env$2("OPENAI_RETRY_DELAY") ?? 1000),
    headers         = {},
    fetch: fetchFn  = globalThis.fetch,
    seed            = _env$2("OPENAI_SEED") != null ? Number(_env$2("OPENAI_SEED")) : undefined,
    generatePrompt  = SYSTEM_GENERATE,
    summarizePrompt = SYSTEM_SUMMARIZE,
  } = {}) {
    super();
    if (!apiKey) throw new AdapterError("ERR_SKALEX_ADAPTER_MISSING_API_KEY", "OpenAILLMAdapter requires an apiKey");
    this.apiKey          = apiKey;
    this.model           = model;
    this.baseUrl         = baseUrl;
    this.maxTokens       = maxTokens;
    this.temperature     = temperature;
    this.topP            = topP;
    this.organization    = organization;
    this.timeout         = timeout;
    this.retries         = retries;
    this.retryDelay      = retryDelay;
    this.headers         = headers;
    this._fetch          = fetchFn;
    this.seed            = seed;
    this.generatePrompt  = generatePrompt;
    this.summarizePrompt = summarizePrompt;
  }

  async generate(schema, nlQuery) {
    const data = await this._post({
      model: this.model,
      messages: [
        { role: "system", content: `${this.generatePrompt}\nSchema: ${JSON.stringify(schema)}` },
        { role: "user", content: nlQuery },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
      ...(this.maxTokens !== undefined && { max_tokens: this.maxTokens }),
      ...(this.seed      !== undefined && { seed:       this.seed }),
    });
    return JSON.parse(data.choices[0].message.content);
  }

  async summarize(texts) {
    const data = await this._post({
      model: this.model,
      messages: [
        {
          role: "system",
          content: this.summarizePrompt,
        },
        { role: "user", content: texts },
      ],
      temperature: this.temperature,
      ...(this.maxTokens !== undefined && { max_tokens: this.maxTokens }),
      ...(this.topP      !== undefined && { top_p:      this.topP }),
      ...(this.seed      !== undefined && { seed:       this.seed }),
    });
    return data.choices[0].message.content.trim();
  }

  async _post(body) {
    const response = await fetchWithRetry(this.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
        ...(this.organization && { "OpenAI-Organization": this.organization }),
        ...this.headers,
      },
      body: JSON.stringify(body),
    }, { retries: this.retries, retryDelay: this.retryDelay, timeout: this.timeout, fetchFn: this._fetch });
    if (!response.ok) {
      const err = (await response.text()).slice(0, 200);
      throw new AdapterError("ERR_SKALEX_ADAPTER_HTTP", `OpenAI API error ${response.status}: ${err}`, { status: response.status, adapter: "openai" });
    }
    return response.json();
  }
}

/**
 * AnthropicLLMAdapter  -  language model adapter using the Anthropic Messages API.
 *
 * Default model: claude-haiku-4-5 (fast and economical).
 * Uses native fetch  -  no additional dependencies.
 *
 * Environment variables (all optional  -  constructor config takes precedence):
 *   ANTHROPIC_API_KEY      -  API key
 *   ANTHROPIC_MODEL        -  model name
 *   ANTHROPIC_BASE_URL     -  full endpoint URL (useful for proxies / Anthropic-compatible APIs)
 *   ANTHROPIC_MAX_TOKENS   -  max tokens for responses (default: 1024)
 *   ANTHROPIC_TEMPERATURE  -  sampling temperature for summarize() (default: 0.3)
 *   ANTHROPIC_TOP_P        -  nucleus sampling for summarize()
 *   ANTHROPIC_TOP_K        -  top-K sampling for summarize()
 *   ANTHROPIC_TIMEOUT      -  request timeout in ms
 *   ANTHROPIC_RETRIES      -  number of retry attempts on failure (default: 0)
 *   ANTHROPIC_RETRY_DELAY  -  base retry delay in ms, doubles each attempt (default: 1000)
 */

const _env$1 = k => globalThis.process?.env?.[k] ?? globalThis.Deno?.env?.get(k);

class AnthropicLLMAdapter extends LLMAdapter {
  /**
   * @param {object}   [config]
   * @param {string}   [config.apiKey]      - Anthropic API key. Falls back to ANTHROPIC_API_KEY env var.
   * @param {string}   [config.model]       - Model name. Default: "claude-haiku-4-5". Falls back to ANTHROPIC_MODEL env var.
   * @param {string}   [config.baseUrl]     - API endpoint. Default: "https://api.anthropic.com/v1/messages". Falls back to ANTHROPIC_BASE_URL env var.
   * @param {string}   [config.apiVersion]  - Anthropic-Version header. Default: "2023-06-01".
   * @param {number}   [config.maxTokens]   - Max tokens for responses. Default: 1024. Falls back to ANTHROPIC_MAX_TOKENS env var.
   * @param {number}   [config.temperature] - Sampling temperature for summarize(). Default: 0.3. generate() always uses 0. Falls back to ANTHROPIC_TEMPERATURE env var.
   * @param {number}   [config.topP]        - Nucleus sampling for summarize(). Falls back to ANTHROPIC_TOP_P env var.
   * @param {number}   [config.topK]        - Top-K sampling for summarize(). Falls back to ANTHROPIC_TOP_K env var.
   * @param {number}   [config.timeout]     - Request timeout in ms. Falls back to ANTHROPIC_TIMEOUT env var.
   * @param {number}   [config.retries]         - Retry attempts on failure. Default: 0. Falls back to ANTHROPIC_RETRIES env var.
   * @param {number}   [config.retryDelay]      - Base retry delay in ms (doubles each attempt). Default: 1000. Falls back to ANTHROPIC_RETRY_DELAY env var.
   * @param {object}   [config.headers]         - Custom headers merged into every request.
   * @param {Function} [config.fetch]           - Custom fetch implementation. Default: globalThis.fetch.
   * @param {string}   [config.generatePrompt]  - System prompt for generate(). Defaults to built-in query-assistant prompt. Schema is always appended.
   * @param {string}   [config.summarizePrompt] - System prompt for summarize(). Defaults to built-in summarization prompt.
   */
  constructor({
    apiKey          = _env$1("ANTHROPIC_API_KEY"),
    model           = _env$1("ANTHROPIC_MODEL")       ?? "claude-haiku-4-5",
    baseUrl         = _env$1("ANTHROPIC_BASE_URL")    ?? "https://api.anthropic.com/v1/messages",
    apiVersion      = "2023-06-01",
    maxTokens       = Number(_env$1("ANTHROPIC_MAX_TOKENS")   ?? 1024),
    temperature     = Number(_env$1("ANTHROPIC_TEMPERATURE")  ?? 0.3),
    topP            = _env$1("ANTHROPIC_TOP_P")    != null ? Number(_env$1("ANTHROPIC_TOP_P"))    : undefined,
    topK            = _env$1("ANTHROPIC_TOP_K")    != null ? Number(_env$1("ANTHROPIC_TOP_K"))    : undefined,
    timeout         = _env$1("ANTHROPIC_TIMEOUT")  != null ? Number(_env$1("ANTHROPIC_TIMEOUT"))  : undefined,
    retries         = Number(_env$1("ANTHROPIC_RETRIES")     ?? 0),
    retryDelay      = Number(_env$1("ANTHROPIC_RETRY_DELAY") ?? 1000),
    headers         = {},
    fetch: fetchFn  = globalThis.fetch,
    generatePrompt  = SYSTEM_GENERATE,
    summarizePrompt = SYSTEM_SUMMARIZE,
  } = {}) {
    super();
    if (!apiKey) throw new AdapterError("ERR_SKALEX_ADAPTER_MISSING_API_KEY", "AnthropicLLMAdapter requires an apiKey");
    this.apiKey          = apiKey;
    this.model           = model;
    this.baseUrl         = baseUrl;
    this.apiVersion      = apiVersion;
    this.maxTokens       = maxTokens;
    this.temperature     = temperature;
    this.topP            = topP;
    this.topK            = topK;
    this.timeout         = timeout;
    this.retries         = retries;
    this.retryDelay      = retryDelay;
    this.headers         = headers;
    this._fetch          = fetchFn;
    this.generatePrompt  = generatePrompt;
    this.summarizePrompt = summarizePrompt;
  }

  async generate(schema, nlQuery) {
    const data = await this._post({
      model: this.model,
      max_tokens: this.maxTokens,
      temperature: 0,
      system: `${this.generatePrompt}\nSchema: ${JSON.stringify(schema)}`,
      messages: [{ role: "user", content: nlQuery }],
    });
    const text = data.content[0].text.trim()
      .replace(/^```(?:json)?\n?/, "")
      .replace(/\n?```$/, "");
    return JSON.parse(text);
  }

  async summarize(texts) {
    const data = await this._post({
      model: this.model,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      ...(this.topP !== undefined && { top_p: this.topP }),
      ...(this.topK !== undefined && { top_k: this.topK }),
      system: this.summarizePrompt,
      messages: [{ role: "user", content: texts }],
    });
    return data.content[0].text.trim();
  }

  async _post(body) {
    const response = await fetchWithRetry(this.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": this.apiVersion,
        ...this.headers,
      },
      body: JSON.stringify(body),
    }, { retries: this.retries, retryDelay: this.retryDelay, timeout: this.timeout, fetchFn: this._fetch });
    if (!response.ok) {
      const err = (await response.text()).slice(0, 200);
      throw new AdapterError("ERR_SKALEX_ADAPTER_HTTP", `Anthropic API error ${response.status}: ${err}`, { status: response.status, adapter: "anthropic" });
    }
    return response.json();
  }
}

/**
 * OllamaLLMAdapter  -  language model adapter using a local Ollama server.
 *
 * Default model: llama3.2
 * Default host:  http://localhost:11434
 *
 * Run locally: ollama pull llama3.2
 *
 * Environment variables (all optional  -  constructor config takes precedence):
 *   OLLAMA_HOST         -  Ollama server URL
 *   OLLAMA_MODEL        -  model name
 *   OLLAMA_TEMPERATURE  -  sampling temperature for summarize() (default: 0.3)
 *   OLLAMA_TOP_P        -  nucleus sampling for summarize()
 *   OLLAMA_TOP_K        -  top-K sampling for summarize()
 *   OLLAMA_TIMEOUT      -  request timeout in ms
 *   OLLAMA_RETRIES      -  number of retry attempts on failure (default: 0)
 *   OLLAMA_RETRY_DELAY  -  base retry delay in ms, doubles each attempt (default: 1000)
 */

const _env = k => globalThis.process?.env?.[k] ?? globalThis.Deno?.env?.get(k);

class OllamaLLMAdapter extends LLMAdapter {
  /**
   * @param {object}   [config]
   * @param {string}   [config.model]       - Ollama model name. Default: "llama3.2". Falls back to OLLAMA_MODEL env var.
   * @param {string}   [config.host]        - Ollama server URL. Default: "http://localhost:11434". Falls back to OLLAMA_HOST env var.
   * @param {number}   [config.temperature] - Sampling temperature for summarize(). Default: 0.3. generate() always uses 0. Falls back to OLLAMA_TEMPERATURE env var.
   * @param {number}   [config.topP]        - Nucleus sampling for summarize(). Falls back to OLLAMA_TOP_P env var.
   * @param {number}   [config.topK]        - Top-K sampling for summarize(). Falls back to OLLAMA_TOP_K env var.
   * @param {number}   [config.timeout]     - Request timeout in ms. Falls back to OLLAMA_TIMEOUT env var.
   * @param {number}   [config.retries]         - Retry attempts on failure. Default: 0. Falls back to OLLAMA_RETRIES env var.
   * @param {number}   [config.retryDelay]      - Base retry delay in ms (doubles each attempt). Default: 1000. Falls back to OLLAMA_RETRY_DELAY env var.
   * @param {object}   [config.headers]         - Custom headers merged into every request.
   * @param {Function} [config.fetch]           - Custom fetch implementation. Default: globalThis.fetch.
   * @param {string}   [config.generatePrompt]  - System prompt for generate(). Defaults to built-in query-assistant prompt. Schema and query are always appended.
   * @param {string}   [config.summarizePrompt] - System prompt prefix for summarize(). Defaults to built-in summarization prompt.
   */
  constructor({
    model           = _env("OLLAMA_MODEL") ?? "llama3.2",
    host            = _env("OLLAMA_HOST")  ?? "http://localhost:11434",
    temperature     = Number(_env("OLLAMA_TEMPERATURE") ?? 0.3),
    topP            = _env("OLLAMA_TOP_P")    != null ? Number(_env("OLLAMA_TOP_P"))    : undefined,
    topK            = _env("OLLAMA_TOP_K")    != null ? Number(_env("OLLAMA_TOP_K"))    : undefined,
    timeout         = _env("OLLAMA_TIMEOUT")  != null ? Number(_env("OLLAMA_TIMEOUT"))  : undefined,
    retries         = Number(_env("OLLAMA_RETRIES")     ?? 0),
    retryDelay      = Number(_env("OLLAMA_RETRY_DELAY") ?? 1000),
    headers         = {},
    fetch: fetchFn  = globalThis.fetch,
    generatePrompt  = SYSTEM_GENERATE,
    summarizePrompt = SYSTEM_SUMMARIZE,
  } = {}) {
    super();
    this.model           = model;
    this.host            = host;
    this.temperature     = temperature;
    this.topP            = topP;
    this.topK            = topK;
    this.timeout         = timeout;
    this.retries         = retries;
    this.retryDelay      = retryDelay;
    this.headers         = headers;
    this._fetch          = fetchFn;
    this.generatePrompt  = generatePrompt;
    this.summarizePrompt = summarizePrompt;
  }

  async generate(schema, nlQuery) {
    const prompt = `${this.generatePrompt}\nSchema: ${JSON.stringify(schema)}\nQuery: ${nlQuery}`;
    const data = await this._post({
      model: this.model,
      prompt,
      format: "json",
      options: { temperature: 0 },
      stream: false,
    });
    return JSON.parse(data.response);
  }

  async summarize(texts) {
    const data = await this._post({
      model: this.model,
      prompt: `${this.summarizePrompt}\n\n${texts}`,
      options: {
        temperature: this.temperature,
        ...(this.topP !== undefined && { top_p: this.topP }),
        ...(this.topK !== undefined && { top_k: this.topK }),
      },
      stream: false,
    });
    return data.response.trim();
  }

  async _post(body) {
    const response = await fetchWithRetry(`${this.host}/api/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.headers,
      },
      body: JSON.stringify(body),
    }, { retries: this.retries, retryDelay: this.retryDelay, timeout: this.timeout, fetchFn: this._fetch });
    if (!response.ok) {
      const err = (await response.text()).slice(0, 200);
      throw new AdapterError("ERR_SKALEX_ADAPTER_HTTP", `Ollama API error ${response.status}: ${err}`, { status: response.status, adapter: "ollama" });
    }
    return response.json();
  }
}

/**
 * adapters.js  -  AI adapter factory functions.
 *
 * Pure config-to-instance mappers extracted from Skalex constructor.
 */

/**
 * Create an embedding adapter from AI config.
 * @param {object} ai
 * @returns {import("../connectors/embedding/base.js").default}
 */
function createEmbeddingAdapter({ provider, apiKey, embedModel, model, host, embedBaseUrl, dimensions, organization, embedTimeout, embedRetries, embedRetryDelay }) {
  const resolvedModel = embedModel || model;
  switch (provider) {
    case "openai":
      return new OpenAIEmbeddingAdapter({
        apiKey,
        model: resolvedModel,
        baseUrl: embedBaseUrl,
        ...(dimensions !== undefined && { dimensions }),
        ...(organization !== undefined && { organization }),
        ...(embedTimeout !== undefined && { timeout: embedTimeout }),
        ...(embedRetries !== undefined && { retries: embedRetries }),
        ...(embedRetryDelay !== undefined && { retryDelay: embedRetryDelay }),
      });
    case "ollama":
      return new OllamaEmbeddingAdapter({
        model: resolvedModel,
        host,
        ...(embedTimeout !== undefined && { timeout: embedTimeout }),
        ...(embedRetries !== undefined && { retries: embedRetries }),
        ...(embedRetryDelay !== undefined && { retryDelay: embedRetryDelay }),
      });
    default:
      throw new AdapterError(
        "ERR_SKALEX_ADAPTER_UNKNOWN_PROVIDER",
        `Unknown AI provider: "${provider}". Supported: "openai", "ollama".`,
        { provider }
      );
  }
}

/**
 * Create a language model adapter from AI config.
 * @param {object} ai
 * @returns {import("../connectors/llm/base.js").default|null}
 */
function createLLMAdapter({ provider, apiKey, model, host, baseUrl, apiVersion, temperature, maxTokens, topP, topK, organization, timeout, retries, retryDelay, seed, generatePrompt, summarizePrompt }) {
  if (!model) return null;
  switch (provider) {
    case "openai":
      return new OpenAILLMAdapter({
        apiKey,
        model,
        baseUrl,
        ...(maxTokens !== undefined && { maxTokens }),
        ...(temperature !== undefined && { temperature }),
        ...(topP !== undefined && { topP }),
        ...(organization !== undefined && { organization }),
        ...(timeout !== undefined && { timeout }),
        ...(retries !== undefined && { retries }),
        ...(retryDelay !== undefined && { retryDelay }),
        ...(seed !== undefined && { seed }),
        ...(generatePrompt !== undefined && { generatePrompt }),
        ...(summarizePrompt !== undefined && { summarizePrompt }),
      });
    case "anthropic":
      return new AnthropicLLMAdapter({
        apiKey,
        model,
        baseUrl,
        apiVersion,
        ...(maxTokens !== undefined && { maxTokens }),
        ...(temperature !== undefined && { temperature }),
        ...(topP !== undefined && { topP }),
        ...(topK !== undefined && { topK }),
        ...(timeout !== undefined && { timeout }),
        ...(retries !== undefined && { retries }),
        ...(retryDelay !== undefined && { retryDelay }),
        ...(generatePrompt !== undefined && { generatePrompt }),
        ...(summarizePrompt !== undefined && { summarizePrompt }),
      });
    case "ollama":
      return new OllamaLLMAdapter({
        model,
        host,
        ...(temperature !== undefined && { temperature }),
        ...(topP !== undefined && { topP }),
        ...(topK !== undefined && { topK }),
        ...(timeout !== undefined && { timeout }),
        ...(retries !== undefined && { retries }),
        ...(retryDelay !== undefined && { retryDelay }),
        ...(generatePrompt !== undefined && { generatePrompt }),
        ...(summarizePrompt !== undefined && { summarizePrompt }),
      });
    default:
      throw new AdapterError(
        "ERR_SKALEX_ADAPTER_UNKNOWN_PROVIDER",
        `Unknown LLM provider: "${provider}". Supported: "openai", "anthropic", "ollama".`,
        { provider }
      );
  }
}

/**
 * EncryptedAdapter  -  wraps any StorageAdapter with AES-256-GCM encryption.
 *
 * All data written to the underlying adapter is encrypted; reads are decrypted
 * transparently. The encryption layer is completely invisible to callers.
 *
 * Algorithm : AES-256-GCM
 * IV         : 12 random bytes per write (GCM recommendation)
 * Auth tag   : 128-bit, appended to ciphertext
 * Wire format: base64( iv[12] | ciphertext+tag[n+16] )
 *
 * Uses the Web Crypto API (globalThis.crypto.subtle) which is available in
 * Node.js ≥18, Bun, Deno, and all modern browsers  -  no extra dependencies.
 *
 * Key formats accepted:
 *   - 64-character hex string  (32 bytes)
 *   - Uint8Array / Buffer      (32 bytes)
 */

const ALGO    = "AES-GCM";
const IV_LEN  = 12;   // bytes  -  recommended for GCM
const KEY_LEN = 32;   // bytes  -  AES-256

const _encoder = new TextEncoder();
const _decoder = new TextDecoder();

class EncryptedAdapter extends StorageAdapter {
  /**
   * @param {StorageAdapter} adapter    - Underlying storage backend.
   * @param {string|Uint8Array} key     - 256-bit key (hex string or bytes).
   */
  constructor(adapter, key) {
    super();
    this._adapter = adapter;
    this._rawKey = typeof key === "string" ? _hexToBytes(key) : Uint8Array.from(key);

    if (this._rawKey.length !== KEY_LEN) {
      throw new AdapterError(
        "ERR_SKALEX_ADAPTER_INVALID_KEY",
        `EncryptedAdapter: key must be ${KEY_LEN} bytes (${KEY_LEN * 2} hex chars), got ${this._rawKey.length}`
      );
    }

    this._cryptoKey = null; // lazily imported CryptoKey
  }

  async read(name) {
    const raw = await this._adapter.read(name);
    if (!raw) return null;
    return this._decrypt(raw);
  }

  async write(name, data) {
    return this._adapter.write(name, await this._encrypt(data));
  }

  async delete(name) {
    return this._adapter.delete(name);
  }

  async list() {
    return this._adapter.list();
  }

  async writeAll(entries) {
    const encrypted = [];
    for (const { name, data } of entries) {
      encrypted.push({ name, data: await this._encrypt(data) });
    }
    return this._adapter.writeAll(encrypted);
  }

  // ─── FsAdapter extension passthrough ────────────────────────────────────────
  // These stubs forward optional FsAdapter-specific methods (used by export/import).

  join(...args) { return this._adapter.join?.(...args); }
  ensureDir(dir) { return this._adapter.ensureDir?.(dir); }
  cleanOrphans() { return this._adapter.cleanOrphans?.(); }
  get dir() { return this._adapter.dir; }

  async writeRaw(path, data) {
    return this._adapter.writeRaw?.(path, await this._encrypt(data));
  }

  async readRaw(path) {
    const raw = await this._adapter.readRaw?.(path);
    if (!raw) return null;
    return this._decrypt(raw);
  }

  // ─── Crypto ──────────────────────────────────────────────────────────────────

  async _getKey() {
    if (!this._cryptoKey) {
      this._cryptoKey = await globalThis.crypto.subtle.importKey(
        "raw",
        this._rawKey,
        { name: ALGO },
        false,
        ["encrypt", "decrypt"]
      );
    }
    return this._cryptoKey;
  }

  async _encrypt(plaintext) {
    const key = await this._getKey();
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_LEN));
    const encoded = _encoder.encode(plaintext);

    const cipherBuf = await globalThis.crypto.subtle.encrypt(
      { name: ALGO, iv, tagLength: 128 },
      key,
      encoded
    );

    // Wire format: iv (12 bytes) | ciphertext + auth-tag (n+16 bytes)
    const combined = new Uint8Array(IV_LEN + cipherBuf.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(cipherBuf), IV_LEN);

    return _toBase64(combined);
  }

  async _decrypt(base64) {
    const key = await this._getKey();
    const combined = _fromBase64(base64);
    const iv = combined.slice(0, IV_LEN);
    const cipherWithTag = combined.slice(IV_LEN);

    const plainBuf = await globalThis.crypto.subtle.decrypt(
      { name: ALGO, iv, tagLength: 128 },
      key,
      cipherWithTag
    );

    return _decoder.decode(plainBuf);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _hexToBytes(hex) {
  if (hex.length !== KEY_LEN * 2) {
    throw new AdapterError(
      "ERR_SKALEX_ADAPTER_INVALID_KEY",
      `EncryptedAdapter: hex key must be ${KEY_LEN * 2} characters (${KEY_LEN} bytes)`
    );
  }
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new AdapterError("ERR_SKALEX_ADAPTER_INVALID_KEY", "EncryptedAdapter: hex key contains invalid characters");
  }
  const bytes = new Uint8Array(KEY_LEN);
  for (let i = 0; i < KEY_LEN; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function _toBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return globalThis.btoa(bin);
}

function _fromBase64(base64) {
  const bin = globalThis.atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Average characters per token (GPT-style 4-char heuristic). */
const CHARS_PER_TOKEN = 4;

/**
 * Session IDs become part of an internal `_memory_<sessionId>` collection
 * name. The collection registry enforces a 64-char limit with a restricted
 * character set; we validate against a compatible subset here so failures
 * surface at `useMemory()` / `new Memory()` instead of at the first method
 * call, with a message that names the right parameter.
 *
 * 56-char cap = 64 (collection name budget) - 8 (`_memory_` prefix).
 */
const _SESSION_ID_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_.:-]{0,55}$/;

/**
 * memory.js  -  episodic agent memory.
 *
 * A Memory instance wraps a private _memory_<sessionId> collection and provides:
 *   remember   -  store a text entry with an embedding
 *   recall     -  semantic search over stored memories
 *   history    -  chronological listing
 *   forget     -  delete a specific entry
 *   context    -  LLM-ready string within a token budget
 *   tokenCount  -  estimate token usage
 *   compress   -  summarise and compact old entries via the language model
 *
 * Requires:
 *   - An embedding adapter (db._embeddingAdapter) for remember() and recall()
 *   - A language model adapter (db._aiAdapter) for compress()
 */
class Memory {
  /**
   * @param {string} sessionId - 1-56 characters. Must start with a letter,
   *   digit, or underscore; subsequent characters may be letters, digits,
   *   or `_ . : -`. The underlying `_memory_<sessionId>` collection name
   *   must satisfy the registry's 64-char limit.
   * @param {object} db  - Skalex instance
   * @throws {ValidationError} ERR_SKALEX_VALIDATION_SESSION_ID when the
   *   session ID is not a string or does not match the allowed shape.
   */
  constructor(sessionId, db) {
    if (typeof sessionId !== "string" || !_SESSION_ID_RE.test(sessionId)) {
      throw new ValidationError(
        "ERR_SKALEX_VALIDATION_SESSION_ID",
        `Invalid Memory sessionId "${sessionId}". Must be 1-56 characters, ` +
        `start with a letter/digit/underscore, and contain only letters, ` +
        `digits, and "_.:-".`,
        { sessionId }
      );
    }
    this.sessionId = sessionId;
    this._db = db;
    this._col = db.useCollection(`_memory_${sessionId}`);
  }

  /**
   * Store a text memory. Embeds the text for later semantic recall.
   * Auto-compresses when maxEntries is configured and the limit is exceeded.
   * @param {string} text
   * @returns {Promise<object>}
   */
  async remember(text) {
    const doc = await this._col.insertOne(
      { text, sessionId: this.sessionId },
      { embed: "text" }
    );
    const maxEntries = this._db._memoryConfig?.maxEntries;
    if (maxEntries && (await this._col.count()) > maxEntries) {
      await this.compress({ threshold: 0 });
    }
    return doc;
  }

  /**
   * Recall the most semantically relevant memories for a query.
   * @param {string} query
   * @param {{ limit?: number, minScore?: number }} [opts]
   * @returns {Promise<{ docs: object[], scores: number[] }>}
   */
  recall(query, { limit = 10, minScore = 0 } = {}) {
    return this._col.search(query, { limit, minScore });
  }

  /**
   * Return memories in chronological order (oldest first).
   * @param {{ since?: string|Date, limit?: number }} [opts]
   * @returns {Promise<object[]>}
   */
  async history({ since, limit } = {}) {
    const filter = since ? { createdAt: { $gte: new Date(since) } } : {};
    const opts = { sort: { createdAt: 1 } };
    if (limit) opts.limit = limit;
    const { docs } = await this._col.find(filter, opts);
    return docs;
  }

  /**
   * Delete a specific memory by _id.
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  forget(id) {
    return this._col.deleteOne({ _id: id });
  }

  /**
   * Estimate the token count of all stored memories (chars / 4 heuristic).
   * Async because it reads through the public Collection API.
   * @returns {Promise<{ tokens: number, count: number }>}
   */
  async tokenCount() {
    const { docs } = await this._col.find({});
    const tokens = docs.reduce((sum, d) => sum + this._docTokens(d), 0);
    return { tokens, count: docs.length };
  }

  /**
   * Return memories as a newline-joined string, newest-first, capped to a token budget.
   * Async because it reads through the public Collection API.
   * @param {{ tokens?: number }} [opts]
   * @returns {Promise<string>}
   */
  async context({ tokens = this._db._memoryConfig?.contextTokens ?? 4000 } = {}) {
    const sorted = await this._sortedData("desc");
    const lines = [];
    let used = 0;

    for (const doc of sorted) {
      const t = this._docTokens(doc);
      if (used + t > tokens) break;
      lines.push(doc.text);
      used += t;
    }

    return lines.reverse().join("\n");
  }

  /**
   * Summarise and compact old memories when total tokens exceed a threshold.
   * Keeps the most recent `keepRecent` entries intact; summarises the rest
   * into one entry via the configured language model adapter.
   * @param {{ threshold?: number, keepRecent?: number }} [opts]
   * @returns {Promise<void>}
   */
  async compress({ threshold = this._db._memoryConfig?.compressionThreshold ?? 8000, keepRecent = this._db._memoryConfig?.keepRecent ?? 10 } = {}) {
    const { tokens } = await this.tokenCount();
    if (tokens <= threshold) return;

    if (!this._db._aiAdapter) {
      throw new AdapterError(
        "ERR_SKALEX_ADAPTER_LLM_REQUIRED",
        "memory.compress() requires a language model adapter. Configure { ai: { model: \"...\" } }."
      );
    }

    const sorted = await this._sortedData("asc");

    const splitAt = Math.max(0, sorted.length - keepRecent);
    const toCompress = sorted.slice(0, splitAt);
    if (toCompress.length === 0) return;

    const texts = toCompress.map(d => d.text).join("\n");
    const summary = await this._db._aiAdapter.summarize(texts);

    await this._col.deleteMany({ _id: { $in: toCompress.map(d => d._id) } });

    await this._col.insertOne({
      text: summary,
      sessionId: this.sessionId,
      compressed: true,
    });
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /** Estimate token count for a single memory doc (chars / CHARS_PER_TOKEN heuristic). */
  _docTokens(doc) {
    return Math.ceil((doc.text || "").length / CHARS_PER_TOKEN);
  }

  /**
   * Return a sorted copy of all memory docs, read via the public find() API
   * so soft-delete, auto-connect, and any future access hooks are honoured.
   * @param {"asc"|"desc"} direction - "asc" = oldest-first, "desc" = newest-first
   * @returns {Promise<object[]>}
   */
  async _sortedData(direction) {
    const { docs } = await this._col.find({});
    return docs.sort(
      direction === "asc"
        ? (a, b) => new Date(a.createdAt) - new Date(b.createdAt)
        : (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    );
  }
}

/**
 * changelog.js  -  per-collection append-only mutation log.
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
    this._restoring = false;
  }

  /** Lazily resolved so it always reflects the current registry state. */
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
    if (this._restoring) return;
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
      // Restore a single document. The archived snapshot is rehydrated
      // directly via the collection's internal `_rehydrateOne` path so
      // timestamps, version, expiry, and vector are preserved exactly.
      const docEntries = relevant.filter(e => e.docId === _id);
      if (docEntries.length === 0) return;

      const last = docEntries[docEntries.length - 1];

      this._restoring = true;
      try {
        const archived = last.op === Ops.DELETE ? null : last.doc;
        col._rehydrateOne(_id, archived);
      } finally {
        this._restoring = false;
      }
      await this._db.saveData(collection);
      return;
    }

    // Restore entire collection - replay all entries in order, then rehydrate
    // the resulting state in a single atomic swap.
    const state = new Map(); // docId → { doc, deleted }

    for (const entry of relevant) {
      if (entry.op === Ops.INSERT || entry.op === Ops.UPDATE) {
        state.set(entry.docId, { doc: entry.doc, deleted: false });
      } else if (entry.op === Ops.DELETE) {
        state.set(entry.docId, { doc: null, deleted: true });
      }
    }

    const restored = [];
    for (const { doc, deleted } of state.values()) {
      if (!deleted && doc) restored.push(doc);
    }

    this._restoring = true;
    try {
      col._rehydrateAll(restored);
    } finally {
      this._restoring = false;
    }
    await this._db.saveData(collection);
  }
}

/**
 * events.js  -  lightweight cross-runtime event bus.
 *
 * Provides pub/sub for collection mutation events consumed by watch() and
 * any other internal subscribers. No Node.js EventEmitter dependency  - 
 * works identically in Node, Bun, Deno, and browsers.
 *
 * Event names are collection names. Subscribers receive a MutationEvent:
 *   { op, collection, doc, prev? }
 */
class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();
  }

  /**
   * Subscribe to events for `event`.
   * Returns an unsubscribe function.
   * @param {string} event
   * @param {Function} fn
   * @returns {() => void}
   */
  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this._listeners.get(event)?.delete(fn);
  }

  /**
   * Unsubscribe a specific listener.
   * @param {string} event
   * @param {Function} fn
   */
  off(event, fn) {
    this._listeners.get(event)?.delete(fn);
  }

  /**
   * Emit an event to all subscribers. Fires both the specific channel and
   * any wildcard ("*") listeners. Errors in listeners are swallowed to
   * prevent a bad subscriber from breaking a mutation.
   * @param {string} event
   * @param {object} data
   */
  emit(event, data) {
    for (const key of [event, "*"]) {
      const fns = this._listeners.get(key);
      if (!fns) continue;
      for (const fn of fns) {
        try { fn(data); } catch (_) { /* swallow  -  watcher errors must not break writes */ }
      }
    }
  }

  /**
   * Remove all listeners for an event, or all listeners if omitted.
   * @param {string} [event]
   */
  removeAll(event) {
    if (event) {
      this._listeners.delete(event);
    } else {
      this._listeners.clear();
    }
  }

  /**
   * @param {string} event
   * @returns {number}
   */
  listenerCount(event) {
    return this._listeners.get(event)?.size ?? 0;
  }
}

/**
 * query-log.js  -  slow query log for find / search operations.
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
    // Ring buffer  -  drop oldest when full
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

/**
 * SessionStats  -  per-session read/write/lastActive tracking.
 *
 * Sessions are keyed by an arbitrary string ID passed via the `session`
 * option on mutation methods and find/search options.
 */
class SessionStats {
  constructor() {
    /** @type {Map<string, { reads: number, writes: number, lastActive: Date }>} */
    this._sessions = new Map();
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  _ensure(sessionId) {
    if (!this._sessions.has(sessionId)) {
      this._sessions.set(sessionId, { reads: 0, writes: 0, lastActive: null });
    }
    return this._sessions.get(sessionId);
  }

  // ─── Record ───────────────────────────────────────────────────────────────

  /**
   * Record a read operation for a session.
   * No-op if sessionId is falsy.
   * @param {string|null|undefined} sessionId
   */
  recordRead(sessionId) {
    if (!sessionId) return;
    const s = this._ensure(sessionId);
    s.reads++;
    s.lastActive = new Date();
  }

  /**
   * Record a write operation for a session.
   * No-op if sessionId is falsy.
   * @param {string|null|undefined} sessionId
   */
  recordWrite(sessionId) {
    if (!sessionId) return;
    const s = this._ensure(sessionId);
    s.writes++;
    s.lastActive = new Date();
  }

  // ─── Query ────────────────────────────────────────────────────────────────

  /**
   * Return stats for a single session, or null if not found.
   * @param {string} sessionId
   * @returns {{ sessionId: string, reads: number, writes: number, lastActive: Date } | null}
   */
  get(sessionId) {
    const s = this._sessions.get(sessionId);
    if (!s) return null;
    return { sessionId, ...s };
  }

  /**
   * Return stats for all tracked sessions.
   * @returns {Array<{ sessionId: string, reads: number, writes: number, lastActive: Date }>}
   */
  all() {
    return [...this._sessions.entries()].map(([sessionId, s]) => ({
      sessionId,
      ...s,
    }));
  }

  /**
   * Clear stats for one session (or all sessions if no ID given).
   * @param {string} [sessionId]
   */
  clear(sessionId) {
    if (sessionId) {
      this._sessions.delete(sessionId);
    } else {
      this._sessions.clear();
    }
  }
}

/**
 * PluginEngine  -  pre/post hook system for all database operations.
 *
 * Plugins are plain objects with optional async hook methods.
 * All hooks are awaited in registration order.
 *
 * Available hooks:
 *   beforeInsert(ctx)  / afterInsert(ctx)
 *   beforeUpdate(ctx)  / afterUpdate(ctx)
 *   beforeDelete(ctx)  / afterDelete(ctx)
 *   beforeFind(ctx)    / afterFind(ctx)
 *   beforeSearch(ctx)  / afterSearch(ctx)
 *
 * Context shapes:
 *   beforeInsert  : { collection, doc }
 *   afterInsert   : { collection, doc }            -  doc is the fully inserted document
 *   beforeUpdate  : { collection, filter, update }
 *   afterUpdate   : { collection, filter, update, result }
 *   beforeDelete  : { collection, filter }
 *   afterDelete   : { collection, filter, result }
 *   beforeFind    : { collection, filter, options }
 *   afterFind     : { collection, filter, options, docs }
 *   beforeSearch  : { collection, query, options }
 *   afterSearch   : { collection, query, options, docs, scores }
 *
 * @example
 * db.use({
 *   async beforeInsert({ collection, doc }) {
 *     console.log(`Inserting into ${collection}:`, doc);
 *   },
 *   async afterInsert({ collection, doc }) {
 *     await audit.log("insert", collection, doc._id);
 *   },
 * });
 */
class PluginEngine {
  constructor() {
    /** @type {object[]} */
    this._plugins = [];
  }

  /**
   * Register a plugin.
   * @param {object} plugin - An object with optional hook methods.
   */
  register(plugin) {
    if (typeof plugin !== "object" || plugin === null) {
      throw new ValidationError("ERR_SKALEX_VALIDATION_PLUGIN", "Plugin must be a non-null object.", { got: plugin === null ? "null" : typeof plugin });
    }
    this._plugins.push(plugin);
  }

  /**
   * Run all registered handlers for a given hook name.
   * @param {string} hook - One of the `Hooks` values from src/engine/constants.js.
   * @param {object} context - The context object passed to each handler.
   * @returns {Promise<void>}
   */
  async run(hook, context) {
    for (const plugin of this._plugins) {
      if (typeof plugin[hook] === "function") {
        await plugin[hook](context);
      }
    }
  }

  /**
   * Return the number of registered plugins.
   * @returns {number}
   */
  get size() {
    return this._plugins.length;
  }
}

/**
 * tools.js  -  MCP tool definitions and handlers for Skalex.
 *
 * Each tool exposes one Skalex operation to an AI agent.
 * The handler receives (db, args) and returns a plain value that is
 * JSON-serialised into the MCP content text.
 *
 * Tools:
 *   collections  -  list all collections
 *   schema       -  get schema for a collection
 *   find         -  find documents
 *   insert       -  insert a document
 *   update       -  update matching documents
 *   delete       -  delete matching documents
 *   search       -  semantic similarity search (requires embedding adapter)
 *   ask          -  natural-language query (requires AI adapter)
 *
 * Scopes:
 *   read   -  collections, schema, find, search, ask
 *   write  -  insert, update, delete
 */

/**
 * Maximum allowed depth of a filter tree sanitized from agent input.
 * Real filters rarely exceed 3-4 levels (`$or` → branch → field op); 16
 * gives 4× headroom for complex compound queries. Deeper trees are
 * almost certainly malicious (stack-overflow attempts) or buggy and are
 * rejected with a stable error code.
 */
const MAX_FILTER_DEPTH = 16;

/**
 * Validate a collection name supplied by an AI agent.
 * Rejects names containing path separators or traversal sequences that could
 * escape the data directory when the name is used to construct a file path.
 * @param {string} name
 * @returns {string} The validated name
 */
function _validateCollection(name) {
  if (typeof name !== "string" || !name.trim()) {
    throw new ValidationError(
      "ERR_SKALEX_VALIDATION_MCP_COLLECTION",
      "collection name must be a non-empty string",
      { name }
    );
  }
  if (/[/\\]/.test(name) || name.includes("..") || name.includes("\0")) {
    throw new ValidationError(
      "ERR_SKALEX_VALIDATION_MCP_COLLECTION",
      `invalid collection name: "${name}"`,
      { name }
    );
  }
  if (name.trim().startsWith("_")) {
    throw new ValidationError(
      "ERR_SKALEX_VALIDATION_MCP_COLLECTION",
      `access to system collection "${name}" is not permitted`,
      { name }
    );
  }
  return name.trim();
}

/**
 * Sanitize an MCP-sourced filter. Handles `$fn` according to the registered
 * predicates allowlist:
 *
 * - If `predicates` is provided and `$fn` is a string matching a registered
 *   name, the string is replaced with the real function. The agent gets
 *   `$fn` power without code crossing the wire.
 * - If `$fn` is a string that does NOT match a registered name, it is
 *   stripped and a warning is logged.
 * - If `$fn` is anything other than a string (a function, an object, code),
 *   it is stripped regardless of predicates.
 * - If no `predicates` map is provided, all `$fn` keys are stripped
 *   (alpha.3 default behavior).
 *
 * Traverses into `$or`, `$and`, `$not` branches. Enforces a maximum
 * traversal depth ({@link MAX_FILTER_DEPTH}) so an adversarial agent
 * cannot send a deeply nested payload to blow the call stack.
 *
 * @param {*} filter
 * @param {(msg: string, level?: string) => void} [logger]
 * @param {number} [depth=0] - Current recursion depth (internal).
 * @param {Record<string, Function>} [predicates] - Named predicate allowlist.
 * @returns {*} A new filter with `$fn` keys resolved, stripped, or kept.
 * @throws {ValidationError} ERR_SKALEX_VALIDATION_FILTER_DEPTH when the
 *   filter tree nests deeper than {@link MAX_FILTER_DEPTH}.
 */
function sanitizeFilter(filter, logger, depth = 0, predicates = null) {
  if (depth > MAX_FILTER_DEPTH) {
    throw new ValidationError(
      "ERR_SKALEX_VALIDATION_FILTER_DEPTH",
      `Filter nested too deeply (> ${MAX_FILTER_DEPTH} levels). This limit ` +
      `protects against stack-overflow attacks from agent-supplied filters.`,
      { maxDepth: MAX_FILTER_DEPTH }
    );
  }
  if (filter === null || typeof filter !== "object") return filter;
  if (Array.isArray(filter)) return filter.map(f => sanitizeFilter(f, logger, depth + 1, predicates));
  const out = {};
  for (const key of Object.keys(filter)) {
    if (key === "$fn") {
      const val = filter[key];
      // Only string names can be resolved against the allowlist.
      // Functions, objects, and code strings are always stripped.
      if (typeof val === "string" && predicates && val in predicates) {
        out[key] = predicates[val];
        continue;
      }
      if (logger) logger(`[MCP] $fn stripped from agent-supplied filter`, "warn");
      continue;
    }
    out[key] = sanitizeFilter(filter[key], logger, depth + 1, predicates);
  }
  return out;
}

const TOOL_DEFS = [
  {
    name: "skalex_collections",
    description: "List all collection names in the database.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    scope: "read",
  },
  {
    name: "skalex_schema",
    description: "Return the schema for a collection as a { field: type } map. Returns null if the collection is empty.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Collection name." },
      },
      required: ["collection"],
    },
    scope: "read",
  },
  {
    name: "skalex_find",
    description: "Find documents in a collection that match a filter.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Collection name." },
        filter:     { type: "object", description: "Query filter (MongoDB-style operators supported)." },
        limit:      { type: "number", description: "Maximum number of results. Default: 20." },
        sort:       { type: "object", description: "Sort descriptor: { field: 1 } for ascending, { field: -1 } for descending." },
      },
      required: ["collection"],
    },
    scope: "read",
  },
  {
    name: "skalex_insert",
    description: "Insert a single document into a collection.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Collection name." },
        doc:        { type: "object", description: "Document to insert." },
      },
      required: ["collection", "doc"],
    },
    scope: "write",
  },
  {
    name: "skalex_update",
    description: "Update the first document matching a filter.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Collection name." },
        filter:     { type: "object", description: "Query filter to identify the document." },
        update:     { type: "object", description: "Fields to update (direct assignment, $inc, $push supported)." },
        many:       { type: "boolean", description: "If true, update all matching documents. Default: false." },
      },
      required: ["collection", "filter", "update"],
    },
    scope: "write",
  },
  {
    name: "skalex_delete",
    description: "Delete the first document matching a filter.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Collection name." },
        filter:     { type: "object", description: "Query filter to identify the document." },
        many:       { type: "boolean", description: "If true, delete all matching documents. Default: false." },
      },
      required: ["collection", "filter"],
    },
    scope: "write",
  },
  {
    name: "skalex_search",
    description: "Semantic similarity search. Requires an embedding adapter to be configured.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Collection name." },
        query:      { type: "string", description: "Natural-language query string to embed and compare." },
        limit:      { type: "number", description: "Maximum number of results. Default: 10." },
        minScore:   { type: "number", description: "Minimum cosine similarity score [0, 1]. Default: 0." },
        filter:     { type: "object", description: "Optional structured pre-filter (hybrid search)." },
      },
      required: ["collection", "query"],
    },
    scope: "read",
  },
  {
    name: "skalex_ask",
    description: "Translate a natural-language question into a filter and query a collection. Requires a language model adapter.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Collection name." },
        question:   { type: "string", description: "Natural-language question about the data." },
        limit:      { type: "number", description: "Maximum number of results. Default: 20." },
      },
      required: ["collection", "question"],
    },
    scope: "read",
  },
];

/**
 * Execute a tool call.
 * @param {string} name - Tool name.
 * @param {object} args - Tool arguments.
 * @param {object} db   - Skalex instance.
 * @param {Record<string, Function>|null} [predicates] - Named predicate allowlist.
 * @returns {Promise<object>} Plain value to be JSON.stringify'd into content text.
 */
function callTool(name, args, db, predicates = null) {
  const log = db._logger;
  const _sanitize = (f) => sanitizeFilter(f, log, 0, predicates);
  switch (name) {
    case "skalex_collections":
      return Object.keys(db.collections).filter(n => !n.startsWith("_"));

    case "skalex_schema": {
      const s = db.schema(_validateCollection(args.collection));
      return s ?? null;
    }

    case "skalex_find": {
      const col = db.useCollection(_validateCollection(args.collection));
      const opts = {};
      if (args.limit) opts.limit = args.limit;
      if (args.sort)  opts.sort  = args.sort;
      return col.find(_sanitize(args.filter || {}), opts);
    }

    case "skalex_insert": {
      const col = db.useCollection(_validateCollection(args.collection));
      return col.insertOne(args.doc || {});
    }

    case "skalex_update": {
      const col = db.useCollection(_validateCollection(args.collection));
      const filter = _sanitize(args.filter || {});
      if (args.many) return col.updateMany(filter, args.update || {});
      return col.updateOne(filter, args.update || {});
    }

    case "skalex_delete": {
      const col = db.useCollection(_validateCollection(args.collection));
      const filter = _sanitize(args.filter || {});
      if (args.many) return col.deleteMany(filter);
      return col.deleteOne(filter);
    }

    case "skalex_search": {
      const col = db.useCollection(_validateCollection(args.collection));
      return col.search(args.query, {
        limit:    args.limit    ?? 10,
        minScore: args.minScore ?? 0,
        filter:   _sanitize(args.filter),
      });
    }

    case "skalex_ask":
      return db.ask(_validateCollection(args.collection), args.question, { limit: args.limit ?? 20 });

    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), { code: "NOT_FOUND" });
  }
}

/**
 * protocol.js  -  JSON-RPC 2.0 helpers for the MCP server.
 *
 * MCP (Model Context Protocol) uses JSON-RPC 2.0 as its wire format.
 * These helpers build compliant response/error objects and parse incoming
 * messages without any external dependencies.
 */

const JSONRPC = "2.0";

// Standard JSON-RPC error codes
const PARSE_ERROR      = -32700;
const INVALID_REQUEST  = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS   = -32602;
const INTERNAL_ERROR   = -32603;

/**
 * Build a success response.
 * @param {number|string|null} id
 * @param {object} result
 * @returns {object}
 */
function ok(id, result) {
  return { jsonrpc: JSONRPC, id, result };
}

/**
 * Build an error response.
 * @param {number|string|null} id
 * @param {number} code
 * @param {string} message
 * @param {unknown} [data]
 * @returns {object}
 */
function error(id, code, message, data) {
  const err = { code, message };
  return { jsonrpc: JSONRPC, id, error: err };
}

/**
 * Parse a raw string into a JSON-RPC message.
 * Returns { msg } on success or { parseError } on failure.
 * @param {string} raw
 * @returns {{ msg?: object, parseError?: object }}
 */
function parse(raw) {
  try {
    const msg = JSON.parse(raw);
    if (typeof msg !== "object" || msg === null || msg.jsonrpc !== JSONRPC) {
      return { parseError: error(null, INVALID_REQUEST, "Invalid JSON-RPC request") };
    }
    return { msg };
  } catch (_) {
    return { parseError: error(null, PARSE_ERROR, "Parse error") };
  }
}

/**
 * Build a tool-call success result.
 * MCP tools return content arrays: [{ type: "text", text: string }]
 * @param {string} text
 * @returns {{ content: Array<{ type: string, text: string }> }}
 */
function toolResult(text) {
  return { content: [{ type: "text", text }] };
}

/**
 * Build a tool-call error result.
 * @param {string} message
 * @returns {{ content: Array<{ type: string, text: string }>, isError: true }}
 */
function toolError(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

var http = {};

/**
 * transports/http.js  -  HTTP + SSE transport for the MCP server.
 *
 * Implements the MCP HTTP/SSE transport:
 *   GET  /sse       -  establishes a persistent SSE stream (server → client)
 *   POST /message   -  receives JSON-RPC requests from the client
 *
 * Uses Node's built-in `http` module  -  zero extra dependencies.
 *
 * Multiple simultaneous SSE clients are supported; each receives all
 * server-sent messages (broadcast model).
 */

class HttpTransport {
  /**
   * @param {{ port?: number, host?: string, allowedOrigin?: string | null, maxBodySize?: number }} [opts]
   *   allowedOrigin  -  value for Access-Control-Allow-Origin.
   *   Set to a specific origin (e.g. "http://localhost:5173") or "*" for all origins.
   *   Defaults to null (no CORS header) which is safe for server-to-server use.
   *   Only set to "*" or a broad origin if you explicitly need browser client access.
   *
   *   maxBodySize  -  maximum POST body size in bytes (default: 1 MiB).
   *   Increase if MCP tool calls carry large document payloads (e.g. long text fields).
   */
  constructor({ port = 3000, host = "127.0.0.1", allowedOrigin = null, maxBodySize = 1_048_576 } = {}) {
    this._port          = port;
    this._host          = host;
    this._allowedOrigin = allowedOrigin;
    this._maxBodySize   = maxBodySize;
    this._clients       = new Set(); // active SSE response objects
    this._onMessage     = null;
    this._server        = null;
  }

  /**
   * Register the message handler.
   * @param {(msg: object) => Promise<void>} fn
   */
  onMessage(fn) {
    this._onMessage = fn;
  }

  /**
   * Broadcast a message to all connected SSE clients.
   * @param {object} msg
   */
  send(msg) {
    const data = `data: ${JSON.stringify(msg)}\n\n`;
    for (const res of this._clients) {
      try { res.write(data); } catch (_) { this._clients.delete(res); }
    }
  }

  /**
   * Start the HTTP server.
   * @returns {Promise<void>} Resolves when the server is listening.
   */
  start() {
    return new Promise((resolve, reject) => {
      this._server = http.createServer((req, res) => {
        // CORS headers  -  only set if allowedOrigin is explicitly configured.
        if (this._allowedOrigin) {
          res.setHeader("Access-Control-Allow-Origin",  this._allowedOrigin);
          res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
          res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        }

        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }

        if (req.method === "GET" && req.url === "/sse") {
          this._handleSSE(req, res);
        } else if (req.method === "POST" && req.url === "/message") {
          this._handleMessage(req, res);
        } else {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not Found");
        }
      });

      this._server.on("error", reject);
      this._server.listen(this._port, this._host, () => resolve());
    });
  }

  /** Stop the HTTP server. */
  stop() {
    return new Promise(resolve => {
      if (!this._server) { resolve(); return; }
      for (const res of this._clients) {
        try { res.end(); } catch (_) {}
      }
      this._clients.clear();
      this._server.close(() => resolve());
      this._server = null;
    });
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  _handleSSE(req, res) {
    res.writeHead(200, {
      "Content-Type":  "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection":    "keep-alive",
    });
    // MCP requires the server to send an initial endpoint event with the
    // POST URL so the client knows where to send messages.
    res.write(`event: endpoint\ndata: /message\n\n`);

    this._clients.add(res);

    req.on("close", () => { this._clients.delete(res); });
  }

  async _handleMessage(req, res) {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", c => {
      body += c;
      if (body.length > this._maxBodySize) {
        req.destroy();
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Request body too large" }));
      }
    });
    req.on("end", async () => {
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end("{}");

      let msg;
      try {
        msg = JSON.parse(body);
      } catch (_) {
        this.send(error(null, PARSE_ERROR, "Parse error"));
        return;
      }

      if (this._onMessage) {
        await this._onMessage(msg).catch(() => {});
      }
    });
  }

  get port()  { return this._port; }
  get host()  { return this._host; }
  get url()   { return `http://${this._host}:${this._port}`; }
  get sseUrl(){ return `${this.url}/sse`; }
}

/**
 * transports/stdio.js  -  stdio transport for the MCP server.
 *
 * Reads newline-delimited JSON-RPC messages from stdin and writes
 * responses to stdout. This is the standard MCP transport used by
 * Claude Desktop, Cursor, and other AI tools that spawn local servers.
 *
 * Protocol:
 *   stdin  → one JSON object per line (client → server)
 *   stdout → one JSON object per line (server → client)
 */
class StdioTransport {
  constructor() {
    this._onMessage = null;
    this._buffer    = "";
    this._started   = false;
  }

  /**
   * Register the message handler.
   * @param {(msg: object) => Promise<void>} fn
   */
  onMessage(fn) {
    this._onMessage = fn;
  }

  /**
   * Send a message (server → client).
   * @param {object} msg
   */
  send(msg) {
    process.stdout.write(JSON.stringify(msg) + "\n");
  }

  /** Start listening on stdin. Idempotent. */
  start() {
    if (this._started) return;
    this._started = true;

    process.stdin.setEncoding("utf8");

    process.stdin.on("data", chunk => {
      this._buffer += chunk;
      let idx;
      while ((idx = this._buffer.indexOf("\n")) !== -1) {
        const line = this._buffer.slice(0, idx).trim();
        this._buffer = this._buffer.slice(idx + 1);
        if (line && this._onMessage) {
          let msg;
          try {
            msg = JSON.parse(line);
          } catch (_) {
            this.send(error(null, PARSE_ERROR, "Parse error"));
            continue;
          }
          this._onMessage(msg).catch(() => {});
        }
      }
    });

    process.stdin.on("end", () => {
      process.exit(0);
    });
  }

  /** Stop the transport (remove stdin listeners). */
  stop() {
    process.stdin.removeAllListeners("data");
    process.stdin.removeAllListeners("end");
    this._started = false;
  }
}

/**
 * mcp/index.js  -  SkalexMCPServer
 *
 * Exposes a Skalex database as a set of MCP tools that AI agents (Claude
 * Desktop, Cursor, OpenClaw, custom agents) can call via the Model Context
 * Protocol.
 *
 * Instantiate via db.mcp(opts)  -  do not construct directly.
 *
 * Transports:
 *   stdio (default)  -  newline-delimited JSON on stdin/stdout
 *   http             -  HTTP server + SSE stream
 *
 * Access control:
 *   scopes: { collectionName | '*': ['read'] | ['read', 'write'] }
 *   'read'   -  find, search, ask, schema, collections
 *   'write'  -  insert, update, delete
 *
 * @example
 * // stdio (for Claude Desktop / Cursor tool config)
 * const server = db.mcp();
 * await server.listen();
 *
 * // HTTP + SSE
 * const server = db.mcp({ transport: 'http', port: 3456 });
 * await server.listen();
 */

const SERVER_INFO = { name: "skalex", version: "4.0.0-alpha.6" };
const PROTOCOL_VERSION = "2024-11-05";

class SkalexMCPServer {
  /**
   * @param {object} db                           - Skalex instance.
   * @param {object} [opts]
   * @param {"stdio"|"http"} [opts.transport]     - Transport type. Default: "stdio".
   * @param {number}  [opts.port]                 - HTTP port. Default: 3000.
   * @param {string}  [opts.host]                 - HTTP host. Default: "127.0.0.1".
   * @param {object}  [opts.scopes]               - Access control map. Default: { "*": ["read"] } (read-only).
   * @param {string|null} [opts.allowedOrigin]    - CORS origin for HTTP transport. Default: null (disabled).
   * @param {number}  [opts.maxBodySize]          - Max POST body size in bytes for HTTP transport. Default: 1 MiB.
   * @param {Record<string, Function>} [opts.predicates] - Named predicate allowlist
   *   for `$fn` in agent-supplied filters. Agents reference predicates by name;
   *   the MCP handler resolves the name to the real function. No code crosses
   *   the wire. When omitted, all `$fn` keys are stripped (alpha.3 default).
   */
  constructor(db, opts = {}) {
    this._db            = db;
    this._transport     = opts.transport     || "stdio";
    this._port          = opts.port          || 3000;
    this._host          = opts.host          || "127.0.0.1";
    this._allowedOrigin = opts.allowedOrigin ?? null;
    this._maxBodySize   = opts.maxBodySize   ?? 1_048_576;
    this._scopes        = opts.scopes        || { "*": ["read"] };
    this._predicates    = opts.predicates    || null;
    this._t             = null; // active transport instance
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Start listening on the configured transport.
   * @returns {Promise<void>}
   */
  async listen() {
    if (this._transport === "http") {
      this._t = new HttpTransport({ port: this._port, host: this._host, allowedOrigin: this._allowedOrigin, maxBodySize: this._maxBodySize });
    } else {
      this._t = new StdioTransport();
    }

    this._t.onMessage(msg => this._handleMessage(msg));
    await this._t.start();
  }

  /**
   * Connect a custom transport (used in tests / embedding scenarios).
   * The transport must implement { onMessage(fn), send(msg), start() }.
   * @param {object} transport
   */
  async connect(transport) {
    this._t = transport;
    this._t.onMessage(msg => this._handleMessage(msg));
    if (typeof this._t.start === "function") await this._t.start();
  }

  /** Stop the server. */
  async close() {
    if (this._t && typeof this._t.stop === "function") await this._t.stop();
    this._t = null;
  }

  /** @returns {string} Transport type. */
  get transport() { return this._transport; }

  /** @returns {string|undefined} HTTP URL (http transport only). */
  get url() { return this._t?.url; }

  // ─── Message router ────────────────────────────────────────────────────────

  async _handleMessage(raw) {
    const { msg, parseError } = typeof raw === "string" ? parse(raw) : { msg: raw };
    if (parseError) { this._send(parseError); return; }

    const { id, method, params } = msg;

    // Notifications (no id)  -  acknowledge silently
    if (id === undefined) {
      if (method === "notifications/initialized") return;
      return;
    }

    try {
      switch (method) {
        case "initialize":
          this._send(ok(id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
          }));
          break;

        case "tools/list":
          this._send(ok(id, { tools: this._visibleTools() }));
          break;

        case "tools/call":
          await this._handleToolCall(id, params);
          break;

        case "ping":
          this._send(ok(id, {}));
          break;

        default:
          this._send(error(id, METHOD_NOT_FOUND, `Method not found: ${method}`));
      }
    } catch (err) {
      this._send(error(id, INTERNAL_ERROR, err.message || "Internal error"));
    }
  }

  async _handleToolCall(id, params) {
    const name = params?.name;
    const args = params?.arguments ?? {};

    if (!name) {
      this._send(error(id, INVALID_PARAMS, "tools/call requires params.name"));
      return;
    }

    const def = TOOL_DEFS.find(t => t.name === name);
    if (!def) {
      this._send(error(id, METHOD_NOT_FOUND, `Unknown tool: ${name}`));
      return;
    }

    // Extract collection from args (most tools have one)
    const collection = args.collection || args.collection_name || null;

    if (!this._hasScope(collection, def.scope)) {
      this._send(ok(id, toolError(`Access denied: "${name}" requires "${def.scope}" scope on collection "${collection}".`)));
      return;
    }

    try {
      const result = await callTool(name, args, this._db, this._predicates);
      this._send(ok(id, toolResult(JSON.stringify(result, null, 2))));
    } catch (err) {
      this._send(ok(id, toolError(err.message || String(err))));
    }
  }

  // ─── Access control ────────────────────────────────────────────────────────

  /**
   * Return tool definitions visible to the current scope configuration.
   * Tools whose scope is not granted on any collection are excluded.
   */
  _visibleTools() {
    return TOOL_DEFS.filter(def => {
      // If the global wildcard grants the scope, show the tool
      const global = this._scopes["*"];
      if (global && (global.includes(def.scope) || global.includes("admin"))) return true;
      // If any collection-specific scope grants it, show the tool
      for (const [, perms] of Object.entries(this._scopes)) {
        if (perms.includes(def.scope) || perms.includes("admin")) return true;
      }
      return false;
    });
  }

  /**
   * Check whether a given scope is permitted for a collection.
   * @param {string|null} collection
   * @param {"read"|"write"|"admin"} scope
   * @returns {boolean}
   */
  _hasScope(collection, scope) {
    const check = perms =>
      perms.includes("admin") || perms.includes(scope);

    // collection-specific rule takes precedence over wildcard
    if (collection && this._scopes[collection]) {
      return check(this._scopes[collection]);
    }
    // fall back to wildcard
    if (this._scopes["*"]) {
      return check(this._scopes["*"]);
    }
    return false;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  _send(msg) {
    this._t?.send(msg);
  }
}

/**
 * BigInt- and Date-safe JSON serializer.
 *
 * Encodes BigInt and Date values out-of-band: the data tree stores the string
 * form (ISO for Date, digits for BigInt), and a parallel `meta.types` map
 * records the paths to each typed value so the decoder can reconstruct them.
 *
 * Wire format:
 *   { "data": <encoded-value>, "meta": { "types": { "bigint": [[path...]], "Date": [[path...]] } } }
 *
 * Why out-of-band: the pre-alpha.6 format embedded tagged objects
 * (`{ __skalex_bigint__: "..." }`) directly in the data. Any user document
 * that legitimately stored those keys was silently revived as BigInt/Date
 * on load. Keeping type metadata parallel to the data eliminates that
 * collision - user objects round-trip as themselves.
 *
 * Legacy reads still work: `_deserialize` detects the old inline-tag format
 * and falls through to the original reviver for documents persisted before
 * this change.
 * @param {any} value
 * @returns {string}
 */
const _serialize = (value) => {
  const types = { bigint: [], Date: [] };
  const encoded = _encodeValue(value, [], types);
  const meta = {};
  if (types.bigint.length) meta.bigint = types.bigint;
  if (types.Date.length) meta.Date = types.Date;
  return JSON.stringify({ data: encoded, meta: { types: meta } });
};

/**
 * Walk `v` into a plain JSON-safe structure, recording the path of every
 * BigInt / Date value into `types`. Semantics match `JSON.stringify`:
 *
 *   - `Date` is recorded under `types.Date` and emitted as its ISO string.
 *   - `BigInt` is recorded under `types.bigint` and emitted as its decimal string.
 *   - Any object exposing a `toJSON()` method is walked against that return
 *     value (after the Date/BigInt handlers, so Date's own `toJSON` is not
 *     double-applied).
 *   - Arrays and any non-array object (plain `{}`, `Object.create(null)`, or
 *     class instances with enumerable own properties) walk their own keys.
 *
 * @param {any} v
 * @param {Array<string|number>} path - mutated during traversal; captured per hit
 * @param {{ bigint: Array<Array<string|number>>, Date: Array<Array<string|number>> }} types
 * @returns {any}
 */
function _encodeValue(v, path, types) {
  if (v instanceof Date) {
    types.Date.push(path.slice());
    return v.toISOString();
  }
  if (typeof v === "bigint") {
    types.bigint.push(path.slice());
    return v.toString();
  }
  if (v === null || typeof v !== "object") return v;
  // Honor `toJSON` to match `JSON.stringify` - class instances that expose
  // their own JSON representation are walked against it, not their internals.
  if (typeof v.toJSON === "function") {
    return _encodeValue(v.toJSON(), path, types);
  }
  if (Array.isArray(v)) {
    const out = new Array(v.length);
    for (let i = 0; i < v.length; i++) {
      path.push(i);
      out[i] = _encodeValue(v[i], path, types);
      path.pop();
    }
    return out;
  }
  // Walk any non-array object uniformly. `JSON.stringify` enumerates own
  // enumerable properties regardless of prototype, so `Object.create(null)`
  // containers and class instances with data fields are handled the same.
  const out = {};
  for (const k of Object.keys(v)) {
    path.push(k);
    out[k] = _encodeValue(v[k], path, types);
    path.pop();
  }
  return out;
}

/**
 * Counterpart to `_serialize`. Detects the out-of-band format via the
 * `{ data, meta }` wrapper and reconstructs typed values from `meta.types`.
 * Falls back to the legacy inline-tag reviver for pre-alpha.6 data.
 * @param {string} text
 * @returns {any}
 */
const _deserialize = (text) => {
  const parsed = JSON.parse(text);
  if (_isWrappedPayload(parsed)) {
    let data = parsed.data;
    const typeMap = parsed.meta?.types ?? {};
    if (Array.isArray(typeMap.bigint)) {
      for (const path of typeMap.bigint) {
        data = _applyTypeAtPath(data, path, (s) => BigInt(s));
      }
    }
    if (Array.isArray(typeMap.Date)) {
      for (const path of typeMap.Date) {
        data = _applyTypeAtPath(data, path, (s) => new Date(s));
      }
    }
    return data;
  }
  // Legacy format - revive inline tag objects for backward compatibility.
  return JSON.parse(text, (_, v) => {
    if (v && typeof v === "object") {
      if ("__skalex_bigint__" in v) return BigInt(v.__skalex_bigint__);
      if ("__skalex_date__" in v) return new Date(v.__skalex_date__);
    }
    return v;
  });
};

/**
 * Returns true when the parsed value is an out-of-band wrapped payload.
 * The wrapper has exactly two own keys, `data` and `meta`, and `meta.types`
 * is an object. Any other shape is treated as legacy data.
 * @param {any} v
 * @returns {boolean}
 */
function _isWrappedPayload(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  if (!("data" in v) || !("meta" in v)) return false;
  if (!v.meta || typeof v.meta !== "object") return false;
  if (!("types" in v.meta) || typeof v.meta.types !== "object") return false;
  return true;
}

/**
 * Replace the value at `path` inside `root` with `convert(value)`.
 * Returns the (possibly new) root - when `path` is empty, `root` itself
 * is replaced.
 * @param {any} root
 * @param {Array<string|number>} path
 * @param {(v: any) => any} convert
 * @returns {any}
 */
function _applyTypeAtPath(root, path, convert) {
  if (!Array.isArray(path) || path.length === 0) return convert(root);
  let parent = root;
  for (let i = 0; i < path.length - 1; i++) {
    if (parent == null) return root;
    parent = parent[path[i]];
  }
  if (parent == null) return root;
  const key = path[path.length - 1];
  parent[key] = convert(parent[key]);
  return root;
}

/**
 * Skalex  -  an in-process document database with file-system persistence.
 *
 * @example
 * const db = new Skalex({ path: "./.db" });
 * await db.connect();
 * const users = db.useCollection("users");
 * await users.insertOne({ name: "Alice" });
 */
class Skalex {
  /**
   * @param {object} [config]
   * @param {string}  [config.path="./.db"]  - Data directory path.
   * @param {string}  [config.format="gz"]   - "gz" (compressed) or "json".
   * @param {boolean} [config.debug=false]   - Log debug output.
   * @param {object}  [config.adapter]       - Custom StorageAdapter instance.
   * @param {object}  [config.ai]              - AI configuration (embedding + language model).
   * @param {string}  [config.ai.provider]     - "openai" | "anthropic" | "ollama"
   * @param {string}  [config.ai.apiKey]       - API key (OpenAI / Anthropic).
   * @param {string}  [config.ai.embedModel]   - Embedding model override (falls back to model).
   * @param {string}  [config.ai.model]        - Language model override.
   * @param {string}  [config.ai.host]         - Ollama server URL override.
   * @param {object}  [config.encrypt]             - Encryption configuration.
   * @param {string}  [config.encrypt.key]         - AES-256 key (64-char hex or 32-byte Uint8Array).
   * @param {object}  [config.slowQueryLog]              - Slow query log options.
   * @param {number}  [config.slowQueryLog.threshold]    - Duration threshold in ms. Default: 100.
   * @param {number}  [config.slowQueryLog.maxEntries]   - Max entries to keep. Default: 500.
   * @param {object}  [config.queryCache]                - Query cache options.
   * @param {number}  [config.queryCache.maxSize]        - Max cached entries. Default: 500.
   * @param {number}  [config.queryCache.ttl]            - Cache TTL in ms. Default: 0 (no expiry).
   * @param {object}  [config.memory]                    - Global agent memory options.
   * @param {number}  [config.memory.compressionThreshold] - Token threshold for auto-compress. Default: 8000.
   * @param {number}  [config.memory.maxEntries]         - Max memory entries before auto-compress. Default: none.
   * @param {Function} [config.logger]                   - Custom logger function (message, level) => void.
   * @param {object}  [config.llmAdapter]                - Pre-built LLM adapter instance (overrides ai).
   * @param {object}  [config.embeddingAdapter]          - Pre-built embedding adapter instance (overrides ai).
   * @param {number}  [config.regexMaxLength=500]        - Maximum allowed $regex pattern length in ask() filters.
   * @param {Function} [config.idGenerator]              - Custom document ID generator function. Default: built-in timestamp+random.
   * @param {Function} [config.serializer]               - Custom serializer for storage writes. Default: JSON.stringify.
   * @param {Function} [config.deserializer]             - Custom deserializer for storage reads. Default: JSON.parse.
   * @param {boolean} [config.autoSave=false]            - Automatically persist after every write without passing { save: true }.
   * @param {number}  [config.ttlSweepInterval]          - Interval in ms to periodically sweep expired TTL documents.
   * @param {boolean} [config.lenientLoad=false]         - On `connect()`, log and skip collections that fail to deserialize instead of aborting. Use with care.
   * @param {"throw"|"warn"|"ignore"} [config.deferredEffectErrors="warn"] - Strategy for errors thrown by deferred side effects (watch callbacks, after-* plugin hooks, changelog entries) after a transaction commit. `"throw"` aggregates into `AggregateError`, `"warn"` logs and continues, `"ignore"` swallows. Can be overridden per transaction via `transaction(fn, { deferredEffectErrors })`.
   */
  constructor(config = {}) {
    const { path = "./.db", format = "gz", debug = false, adapter, ai, encrypt, slowQueryLog, queryCache, memory, logger: logger$1, plugins, llmAdapter, embeddingAdapter, regexMaxLength, idGenerator, serializer, deserializer, autoSave, ttlSweepInterval, lenientLoad, deferredEffectErrors = "warn" } = config;
    validateDeferredEffectErrors(deferredEffectErrors, "Skalex config");
    this._deferredEffectErrors = deferredEffectErrors;
    /** Preserve the original config so namespace() can inherit every option. */
    this._config = config;
    this.dataDirectory = path;
    this.dataFormat = format;
    this.debug = debug;

    // Expose error types as static properties for CJS/UMD consumers.
    // Uses direct references (not a namespace) so tree-shaking cannot remove
    // them - these bindings are already used in throw statements throughout
    // the engine, so Rollup considers them live.
    if (!Skalex._errorsAttached) {
      Skalex.SkalexError = SkalexError;
      Skalex.ValidationError = ValidationError;
      Skalex.UniqueConstraintError = UniqueConstraintError;
      Skalex.TransactionError = TransactionError;
      Skalex.PersistenceError = PersistenceError;
      Skalex.AdapterError = AdapterError;
      Skalex.QueryError = QueryError;
      Skalex._errorsAttached = true;
    }

    this._adapterConfig = adapter ?? null; // track whether a custom adapter was explicitly provided
    // Detect browser/worker environments where FsAdapter will fail because
    // node:fs/path/zlib are unavailable. Checks for `document` (browsers)
    // or `importScripts` (web/service workers), while excluding Deno and
    // Node.js which both define `process` and have real file system access.
    const _isBrowserLike = typeof globalThis.process === "undefined"
      && (typeof globalThis.document !== "undefined" || typeof globalThis.importScripts === "function");
    if (!adapter && _isBrowserLike) {
      throw new AdapterError(
        "ERR_SKALEX_ADAPTER_REQUIRED",
        "Browser/worker usage requires an explicit adapter (e.g. LocalStorageAdapter or a custom adapter). " +
        "Pass { adapter: new LocalStorageAdapter() } to the Skalex constructor."
      );
    }
    let fs = adapter || new FsAdapter({ dir: path, format });
    if (encrypt) fs = new EncryptedAdapter(fs, encrypt.key);
    this.fs = fs;

    this._registry = new CollectionRegistry(Collection);
    this.collections = this._registry.stores;
    this._collectionInstances = this._registry._instances;
    // Built eagerly so Collection constructors can reference a stable object.
    // The ctx uses lazy getters that defer resolution to the database, so
    // referring to it before later fields are initialised is safe.
    this._collectionContext = this._buildCollectionContext();
    this._migrations = new MigrationEngine();
    this._connectPromise = null;
    this.isConnected = false;
    this._bootstrapping = false;

    this._aiConfig = ai || null;
    this._encryptConfig = encrypt || null;
    this._pluginsConfig = Array.isArray(plugins) ? plugins : null;
    this._memoryConfig = memory || null;
    this._idGenerator = idGenerator ?? null;
    this._serializer = serializer ?? _serialize;
    this._deserializer = deserializer ?? _deserialize;
    this._autoSave = autoSave ?? false;
    this._txManager = new TransactionManager();
    this._logger = logger$1 ?? logger;
    this._persistence = new PersistenceManager({
      adapter: this.fs,
      serializer: this._serializer,
      deserializer: this._deserializer,
      logger: this._logger,
      debug: this.debug,
      lenientLoad: lenientLoad ?? false,
      registry: this._registry,
    });
    this._changeLog = new ChangeLog(this);
    this._eventBus = new EventBus();
    this._queryLog = slowQueryLog ? new QueryLog(slowQueryLog) : null;
    this._sessionStats = new SessionStats();
    this._plugins = new PluginEngine();
    // Pre-register any plugins passed to the constructor
    if (Array.isArray(plugins)) {
      for (const p of plugins) this._plugins.register(p);
    }

    // ── Extracted subsystems ──────────────────────────────────────────────
    this._ai = new SkalexAI({
      aiAdapter: llmAdapter ?? (ai ? createLLMAdapter(ai) : null),
      embeddingAdapter: embeddingAdapter ?? (ai ? createEmbeddingAdapter(ai) : null),
      queryCacheConfig: queryCache || {},
      regexMaxLength: regexMaxLength ?? 500,
      persistence: this._persistence,
      getCollections: () => this.collections,
      getCollection: (name) => this.useCollection(name),
      getSchema: (name) => this.schema(name),
      log: (msg) => this._log(msg),
    });
    this._ttlScheduler = new TtlScheduler({
      interval: ttlSweepInterval ?? 0,
      persistence: this._persistence,
      log: (msg) => this._log(msg),
    });
    this._importer = new SkalexImporter({
      fs: this.fs,
      getCollection: (name) => this.useCollection(name),
    });
  }

  // ─── Connection ──────────────────────────────────────────────────────────

  /**
   * Connect to the database: load data, run pending migrations, sweep TTL docs.
   * @returns {Promise<void>}
   */
  connect() {
    if (this._connectPromise) return this._connectPromise;
    this._connectPromise = this._doConnect().catch((err) => {
      this._connectPromise = null;
      throw err;
    });
    return this._connectPromise;
  }

  /**
   * Actual connect implementation.
   *
   * Sets `_bootstrapping` before migrations run so that collection write APIs
   * called inside a migration's `up()` function can bypass `_ensureConnected()`
   * without deadlocking on the still-pending `_connectPromise`.
   * @private
   */
  async _doConnect() {
    try {
      await this.loadData();

      this._bootstrapping = true;

      // Restore persisted query cache
      const meta = this._persistence.getMeta(this.collections);
      if (meta.queryCache) this._ai.queryCache.fromJSON(meta.queryCache);

      // Run pending migrations. Each migration runs in its own transaction
      // and records its version in `_meta` atomically with its data writes
      // via the `recordApplied` closure below. No post-loop flush needed.
      if (this._migrations._migrations.length > 0) {
        const applied = meta.appliedVersions || [];
        const runInTx = (fn) => this.transaction(fn);
        const recordApplied = (versions) => this._recordAppliedVersions(versions);
        await this._migrations.run({ runInTx, recordApplied }, applied);
      }

      // Sweep expired TTL documents and start periodic sweep if configured
      this._ttlScheduler.sweep(this.collections);
      this._ttlScheduler.start(this.collections);

      this.isConnected = true;
      this._log("> - Connected to the database (√)");
    } catch (error) {
      this._logger(`Error connecting to the database: ${error}`, "error");
      throw error;
    } finally {
      this._bootstrapping = false;
    }
  }

  /**
   * Disconnect: flush all unsaved data, clear in-memory state.
   * @returns {Promise<void>}
   */
  async disconnect() {
    try {
      this._ttlScheduler.stop();
      await this.saveData();
      this._registry.clear();
      this.collections = this._registry.stores;
      this._collectionInstances = this._registry._instances;
      this._connectPromise = null;
      this.isConnected = false;
      this._log("> - Disconnected from the database (√)");
    } catch (error) {
      this._logger(`Error disconnecting from the database: ${error}`, "error");
      throw error;
    }
  }

  /**
   * Ensure connect() has been called before proceeding.
   * Triggers auto-connect on the first operation if not already connected.
   * Returns immediately during the bootstrap phase (after loadData but before
   * isConnected) so migrations can use collection APIs without deadlocking.
   * @returns {Promise<void>}
   */
  _ensureConnected() {
    if (this.isConnected || this._bootstrapping) return undefined;
    return this.connect();
  }

  // ─── Collections ─────────────────────────────────────────────────────────

  /**
   * Get (or lazily create) a Collection instance by name.
   * @param {string} collectionName
   * @returns {Collection}
   */
  useCollection(collectionName) {
    return this._registry.get(collectionName, this);
  }

  /**
   * Define a collection with optional schema, indexes, and behaviour options.
   * Must be called before connect() so configuration is available when loading data.
   * @param {string} collectionName
   * @param {object} [options]
   * @returns {Collection}
   */
  createCollection(collectionName, options = {}) {
    return this._registry.create(collectionName, options, this);
  }

  /** @private Create a bare collection store (used internally by persistence/tests). */
  _createCollectionStore(collectionName, options = {}) {
    this._registry.createStore(collectionName, options);
  }

  /**
   * Rename a collection. Updates in-memory state and persists the new name.
   * Requires the storage adapter to support `delete(name)`.
   * @param {string} from
   * @param {string} to
   * @returns {Promise<void>}
   */
  async renameCollection(from, to) {
    this._registry.rename(from, to);
    await this.saveData(to);
    await this.fs.delete(from);
  }

  // ─── Persistence ─────────────────────────────────────────────────────────

  /**
   * Load all collections from the storage adapter.
   * @returns {Promise<void>}
   */
  async loadData() {
    await this._persistence.loadAll(this.collections, {
      parseSchema,
      buildIndex: this._registry.buildIndex,
      IndexEngine,
    });

    // Sync cached Collection instances with reloaded stores.
    // loadAll() replaces store objects in this.collections - any pre-existing
    // Collection instance still points to the old (empty) store.
    for (const name in this._collectionInstances) {
      const store = this.collections[name];
      if (store && this._collectionInstances[name]._store !== store) {
        this._collectionInstances[name]._store = store;
      }
    }
  }

  /**
   * Persist one or all collections via the storage adapter.
   *
   * Best-effort: each collection is written independently. If one fails,
   * others may already be committed. For atomic multi-collection writes,
   * use transaction() which calls saveAtomic() on commit.
   *
   * @param {string} [collectionName] - If omitted, saves all collections.
   * @returns {Promise<void>}
   */
  async saveData(collectionName) {
    await this._persistence.save(this.collections, collectionName);
  }

  /**
   * Build a Map index from an array of documents.
   * @param {object[]} data
   * @param {string} keyField
   * @returns {Map}
   */
  buildIndex(data, keyField) {
    return this._registry.buildIndex(data, keyField);
  }

  // ─── Migrations ──────────────────────────────────────────────────────────

  /**
   * Register a migration to run on next connect().
   * @param {{ version: number, description?: string, up: Function }} migration
   */
  addMigration(migration) {
    this._migrations.add(migration);
  }

  /**
   * Report which migrations are applied vs pending.
   * @returns {{ current: number, applied: number[], pending: number[] }}
   */
  migrationStatus() {
    const meta = this._persistence.getMeta(this.collections);
    return this._migrations.status(meta.appliedVersions || []);
  }

  // ─── Namespace ───────────────────────────────────────────────────────────

  /**
   * Create a scoped Skalex instance that stores data under a sub-directory.
   * @param {string} id
   * @returns {Skalex}
   */
  namespace(id) {
    if (this._adapterConfig) {
      throw new AdapterError(
        "ERR_SKALEX_ADAPTER_NAMESPACE_REQUIRES_FS",
        "namespace() requires the default FsAdapter. When a custom storage adapter is configured, create a separate Skalex instance with your adapter instead."
      );
    }
    // Strip path separators and traversal sequences  -  only alphanumeric, dash, and underscore allowed.
    const safeId = String(id).replace(/[^a-zA-Z0-9_-]/g, "_");
    if (!safeId) throw new ValidationError("ERR_SKALEX_VALIDATION_NAMESPACE_ID", "namespace: id must contain at least one alphanumeric character", { id });
    // Inherit every option from the parent by spreading the stored config,
    // then override only the path. Any new config option added to the
    // constructor is automatically inherited without touching this method.
    return new Skalex({
      ...this._config,
      path: `${this.dataDirectory}/${safeId}`,
    });
  }

  // ─── Plugins ──────────────────────────────────────────────────────────────

  /**
   * Register a plugin. Plugins are plain objects with optional async hook
   * methods: beforeInsert, afterInsert, beforeUpdate, afterUpdate,
   * beforeDelete, afterDelete, beforeFind, afterFind, beforeSearch, afterSearch.
   *
   * @param {object} plugin
   */
  use(plugin) {
    this._plugins.register(plugin);
  }

  // ─── Global Watch ─────────────────────────────────────────────────────────

  /**
   * Subscribe to all mutation events across every collection.
   * Returns an unsubscribe function.
   *
   * @param {Function} callback - Receives { op, collection, doc, prev? } for every mutation.
   * @returns {() => void}
   */
  watch(callback) {
    return this._eventBus.on("*", callback);
  }

  // ─── Session Stats ────────────────────────────────────────────────────────

  /**
   * Return per-session read/write stats.
   * Pass a sessionId to get stats for one session, or omit to get all.
   *
   * @param {string} [sessionId]
   * @returns {{ sessionId: string, reads: number, writes: number, lastActive: Date } | Array | null}
   */
  sessionStats(sessionId) {
    if (sessionId !== undefined) return this._sessionStats.get(sessionId);
    return this._sessionStats.all();
  }

  /** Whether a transaction is currently active. */
  get _inTransaction() { return this._txManager.active; }

  // ─── Transaction helpers ─────────────────────────────────────────────────

  /**
   * Emit a collection event, or defer for after-commit if inside a transaction.
   * @param {string} collectionName
   * @param {object} data
   */
  _emitEvent(collectionName, data) {
    if (!this._txManager.defer(() => this._eventBus.emit(collectionName, data))) {
      this._eventBus.emit(collectionName, data);
    }
  }

  /**
   * Run an after-* plugin hook, or defer for after-commit if inside a transaction.
   * @param {string} hook
   * @param {object} data
   */
  async _runAfterHook(hook, data) {
    if (!this._txManager.defer(() => this._plugins.run(hook, data))) {
      await this._plugins.run(hook, data);
    }
  }

  /**
   * Append a changelog entry, or defer for after-commit if inside a transaction.
   * @param {string} op
   * @param {string} collectionName
   * @param {object} doc
   * @param {object|null} prev
   * @param {string|null} session
   */
  async _logChange(op, collectionName, doc, prev, session) {
    if (!this._txManager.defer(() => this._changeLog.log(op, collectionName, doc, prev, session))) {
      await this._changeLog.log(op, collectionName, doc, prev, session);
    }
  }

  /**
   * Record the applied-migrations list into `_meta` atomically with the
   * active transaction. Called by the migration runner inside `up()`'s
   * transaction callback; must NOT be called outside a transaction.
   *
   * Ensures `_meta` exists, snapshots it into the active tx so rollback
   * reverts the version record on failure, and mutates it via the
   * persistence manager. Bypasses the tx proxy's `collections` blockade
   * by closing over `this` directly - the write is still covered by
   * rollback because we went through `snapshotIfNeeded` first.
   *
   * @param {number[]} versions - Sorted list of applied migration versions.
   * @private
   */
  _recordAppliedVersions(versions) {
    // Defensive: this function's atomicity contract depends on running
    // inside an active transaction. Without a tx, snapshotIfNeeded is a
    // no-op and the _meta mutation would persist via a future save
    // instead of being atomically bundled with the migration's data
    // flush. Fail loud so any future refactor that breaks this invariant
    // shows up in tests instead of silently regressing to the pre-F1 bug.
    if (!this._txManager.active) {
      throw new TransactionError(
        "ERR_SKALEX_TX_INVALID_STATE",
        "_recordAppliedVersions must be called inside an active transaction."
      );
    }
    // Ensure _meta exists so we can snapshot and mutate it. If a fresh
    // database has no _meta yet, create it via the registry's single
    // canonical construction path.
    if (!this.collections["_meta"]) {
      this._registry.createStore("_meta");
    }
    const metaStore = this.collections["_meta"];
    // Snapshot _meta into the active transaction. This adds `_meta` to
    // touchedCollections, so saveAtomic() will flush it alongside the
    // migration's data, AND on rollback the snapshot restores _meta to
    // its pre-migration state.
    this._txManager.snapshotIfNeeded(
      "_meta",
      metaStore,
      (col) => this._snapshotCollection(col)
    );
    this._persistence.updateMeta(this.collections, { appliedVersions: versions });
  }

  // ─── Transaction ─────────────────────────────────────────────────────────

  /**
   * Run a callback inside a transaction.
   *
   * Isolation: Skalex provides **read-committed** isolation, not snapshot
   * isolation. Only collections that receive a write are snapshotted
   * (lazily, on first mutation). Reads on untouched collections see the
   * latest committed state, including mutations from outside the transaction.
   * To guarantee a stable view of a collection, perform a write on it first
   * (or a read-then-write) to trigger a snapshot.
   *
   * Nested transactions: transactions are serialised via a promise-chain lock.
   * Calling `transaction()` inside another transaction's callback will throw
   * `TransactionError` with `ERR_SKALEX_TX_NESTED`.
   *
   * Timeout: the timeout is cooperative, not preemptive. When it fires the
   * outer promise rejects, but any in-flight mutation continues until it
   * next reaches an `assertTxAlive()` check. Deferred side effects for the
   * aborted transaction are discarded.
   *
   * Side effects (watch() callbacks, after-* plugin hooks, changelog entries)
   * are deferred during fn() and flushed after successful commit.
   *
   * @param {(db: Skalex) => Promise<any>} fn
   * @param {object} [opts]
   * @param {number} [opts.timeout] - Max ms before abort. 0 = no timeout.
   * @param {"throw"|"warn"|"ignore"} [opts.deferredEffectErrors]
   *   Per-transaction override for the `deferredEffectErrors` strategy.
   *   Defaults to the Skalex instance setting.
   * @returns {Promise<any>} The return value of fn.
   * @throws {TransactionError} ERR_SKALEX_TX_NESTED - called inside another transaction.
   * @throws {TransactionError} ERR_SKALEX_TX_TIMEOUT - timeout elapsed before commit.
   */
  // eslint-disable-next-line require-await -- async wraps the sync-throw nested-tx check as a promise rejection so callers using .catch() (not try/await) still see it.
  async transaction(fn, opts = {}) {
    if (this._txManager.active) {
      throw new TransactionError(
        "ERR_SKALEX_TX_NESTED",
        "Nested transactions are not supported. Calling transaction() inside another transaction's callback would deadlock."
      );
    }
    return this._txManager.run(fn, this, opts);
  }

  // ─── Seed ────────────────────────────────────────────────────────────────

  /**
   * Seed collections with fixture data.
   * @param {object} fixtures - Map of collectionName → docs[].
   * @param {{ reset?: boolean }} [options] - If reset=true, clear before seeding.
   * @returns {Promise<void>}
   */
  async seed(fixtures, { reset = false } = {}) {
    for (const [name, docs] of Object.entries(fixtures)) {
      if (reset && this.collections[name]) {
        this._applySnapshot(name, { data: [], index: new Map() });
        delete this._collectionInstances[name];
      }
      const col = this.useCollection(name);
      await col.insertMany(docs);
    }
    await this.saveData();
  }

  // ─── Dump ────────────────────────────────────────────────────────────────

  /**
   * Return a snapshot of all collection data.
   * @returns {object} Map of collectionName → docs[].
   */
  dump() {
    return this._registry.dump();
  }

  // ─── Inspect ─────────────────────────────────────────────────────────────

  /**
   * Return metadata about one or all collections.
   * @param {string} [collectionName]
   * @returns {object|null}
   */
  inspect(collectionName) {
    return this._registry.inspect(collectionName);
  }

  // ─── Import ──────────────────────────────────────────────────────────────

  /**
   * Import documents from a JSON file into a collection.
   * The collection name is derived from the file name (without extension).
   * Requires FsAdapter (or a compatible adapter that implements `readRaw`).
   * @param {string} filePath - Absolute or relative path to the file.
   * @returns {Promise<Document[]>}
   */
  import(filePath) {
    return this._importer.import(filePath);
  }

  // ─── Embedding ───────────────────────────────────────────────────────────

  /**
   * Embed a text string using the configured embedding adapter.
   * @param {string} text
   * @returns {Promise<number[]>}
   */
  embed(text) {
    return this._ai.embed(text);
  }

  // ─── AI Query ─────────────────────────────────────────────────────────────

  /**
   * Natural-language query: translate `nlQuery` into a filter via the language
   * model and run it against the collection. Results are cached by query hash.
   *
   * @param {string} collectionName
   * @param {string} nlQuery
   * @param {{ limit?: number }} [opts]
   * @returns {Promise<{ docs: object[], page?: number, totalDocs?: number, totalPages?: number }>}
   */
  ask(collectionName, nlQuery, opts) {
    return this._ai.ask(collectionName, nlQuery, opts);
  }

  // ─── Schema ──────────────────────────────────────────────────────────────

  /**
   * Return the schema for a collection as a plain `{ field: type }` object.
   * If no schema was declared, one is inferred from the first document.
   * Returns null if the collection is empty or unknown.
   *
   * @param {string} collectionName
   * @returns {object|null}
   */
  schema(collectionName) {
    return this._registry.schema(collectionName);
  }

  // ─── Agent Memory ─────────────────────────────────────────────────────────

  /**
   * Get (or create) an episodic Memory store for a session.
   * @param {string} sessionId
   * @returns {Memory}
   */
  useMemory(sessionId) {
    return new Memory(sessionId, this);
  }

  // ─── ChangeLog ────────────────────────────────────────────────────────────

  /**
   * Return the shared ChangeLog instance.
   * @returns {ChangeLog}
   */
  changelog() {
    return this._changeLog;
  }

  /**
   * Restore a collection (or a single document) to its state at `timestamp`.
   * @param {string} collectionName
   * @param {string|Date} timestamp
   * @param {{ _id?: string }} [opts]
   * @returns {Promise<void>}
   */
  restore(collectionName, timestamp, opts = {}) {
    return this._changeLog.restore(collectionName, timestamp, opts);
  }

  // ─── Stats ────────────────────────────────────────────────────────────────

  /**
   * Return size statistics for one or all collections.
   * @param {string} [collectionName]
   * @returns {object|object[]}
   */
  stats(collectionName) {
    return this._registry.stats(collectionName);
  }

  // ─── Slow Query Log ───────────────────────────────────────────────────────

  /**
   * Return recorded slow queries (requires slowQueryLog config).
   * @param {{ limit?: number, minDuration?: number, collection?: string }} [opts]
   * @returns {object[]}
   */
  slowQueries(opts = {}) {
    if (!this._queryLog) return [];
    return this._queryLog.entries(opts);
  }

  /**
   * Number of recorded slow query entries currently in the buffer.
   * @returns {number}
   */
  slowQueryCount() {
    return this._queryLog ? this._queryLog.size : 0;
  }

  /**
   * Clear all recorded slow query entries.
   */
  clearSlowQueries() {
    this._queryLog?.clear();
  }

  // ─── MCP Server ───────────────────────────────────────────────────────────

  /**
   * Create a Skalex MCP server that exposes this database as MCP tools.
   *
   * @param {object} [opts]
   * @param {"stdio"|"http"} [opts.transport]  - Transport type. Default: "stdio".
   * @param {number}  [opts.port]              - HTTP port. Default: 3000.
   * @param {string}  [opts.host]              - HTTP host. Default: "127.0.0.1".
   * @param {object}  [opts.scopes]            - Access control map. Default: { "*": ["read"] } (read-only).
   * @returns {SkalexMCPServer}
   */
  mcp(opts = {}) {
    return new SkalexMCPServer(this, opts);
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  /**
   * Build a lazy context that resolves properties at call time.
   * This is safe to call during the constructor before all fields are
   * initialised, because the getters defer resolution until first use.
   * @returns {CollectionContext}
   */
  _buildCollectionContext() {
    const db = this;
    return {
      ensureConnected: () => db._ensureConnected(),
      get txManager() { return db._txManager; },
      get plugins() { return db._plugins; },
      get eventBus() { return db._eventBus; },
      get sessionStats() { return db._sessionStats; },
      get queryLog() { return db._queryLog; },
      get logger() { return db._logger; },
      get persistence() { return db._persistence; },
      get collections() { return db.collections; },
      embed: (text) => db.embed(text),
      get idGenerator() { return db._idGenerator; },
      get autoSave() { return db._autoSave; },
      saveCollection: (name) => db.saveData(name),
      snapshotCollection: (col) => db._snapshotCollection(col),
      getCollection: (name) => db.useCollection(name),
      emitEvent: (name, data) => db._emitEvent(name, data),
      runAfterHook: (hook, data) => db._runAfterHook(hook, data),
      logChange: (op, col, doc, prev, session) => db._logChange(op, col, doc, prev, session),
      get fs() { return db.fs; },
      get dataDirectory() { return db.dataDirectory; },
    };
  }

  get [Symbol.toStringTag]() { return "Skalex"; }

  /** ES2024 explicit resource management: `await using db = new Skalex(...)`. */
  async [Symbol.asyncDispose]() {
    if (this.isConnected) await this.disconnect();
  }

  _log(msg) {
    if (this.debug) this._logger(msg, "info");
  }

  // ── Backward-compatible accessors for extracted subsystem internals ────
  //
  // @deprecated These getters/setters proxy to the alpha.4-extracted
  // subsystems (`_ai`, `_ttlScheduler`). They exist only to avoid breaking
  // tests and internal code that reach into Skalex internals. Scheduled for
  // removal in beta.1. New code should use the canonical owners directly:
  //   - db._ai._embeddingAdapter, db._ai._aiAdapter, db._ai.queryCache,
  //     db._ai._regexMaxLength
  //   - db._ttlScheduler._timer, db._ttlScheduler._interval

  /** @deprecated Use `db._ai._embeddingAdapter`. Removed in beta.1. */
  get _embeddingAdapter() { return this._ai._embeddingAdapter; }
  /** @deprecated Use `db._ai._embeddingAdapter = v`. Removed in beta.1. */
  set _embeddingAdapter(v) { this._ai._embeddingAdapter = v; }

  /** @deprecated Use `db._ai._aiAdapter`. Removed in beta.1. */
  get _aiAdapter() { return this._ai._aiAdapter; }
  /** @deprecated Use `db._ai._aiAdapter = v`. Removed in beta.1. */
  set _aiAdapter(v) { this._ai._aiAdapter = v; }

  /** @deprecated Use `db._ai.queryCache`. Removed in beta.1. */
  get _queryCache() { return this._ai.queryCache; }

  /** @deprecated Use `db._ai._regexMaxLength`. Removed in beta.1. */
  get _regexMaxLength() { return this._ai._regexMaxLength; }

  /** @deprecated Use `db._ttlScheduler._timer`. Removed in beta.1. */
  get _ttlTimer() { return this._ttlScheduler._timer; }
  /** @deprecated Use `db._ttlScheduler._interval`. Removed in beta.1. */
  get _ttlSweepInterval() { return this._ttlScheduler._interval; }

  /**
   * Return a deep snapshot of a collection's mutable state.
   * Uses structuredClone to correctly preserve Date, BigInt, TypedArray,
   * Map, Set, and RegExp values  -  unlike JSON.parse/JSON.stringify.
   * Only data is snapshotted - the _id index and field indexes are rebuilt
   * from the cloned data during _applySnapshot().
   * @param {{ data: object[] }} col
   * @returns {{ data: object[] }}
   */
  _snapshotCollection(col) {
    return { data: structuredClone(col.data) };
  }

  /**
   * Apply a snapshot to a collection, rebuilding its field index if present.
   * @param {string} name
   * @param {{ data: object[], index: Map }} snap
   */
  _applySnapshot(name, snap) {
    const col = this.collections[name];
    if (!col) return;
    col.data = snap.data;
    // Rebuild the _id index from the deep-copied data so all Map values
    // point to the restored objects, not the pre-rollback mutated ones.
    col.index = this.buildIndex(snap.data, "_id");
    if (col.fieldIndex) col.fieldIndex.buildFromData(snap.data);
  }
}

export { AdapterError, Collection, PersistenceError, QueryError, SkalexError, TransactionError, UniqueConstraintError, ValidationError, Skalex as default };
//# sourceMappingURL=skalex.browser.js.map
