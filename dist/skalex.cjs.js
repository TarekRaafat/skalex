'use strict';

var require$$0 = require('path');
var require$$1 = require('fs');
var require$$2 = require('zlib');
var require$$0$1 = require('http');

function getDefaultExportFromCjs (x) {
	return x && x.__esModule && Object.prototype.hasOwnProperty.call(x, 'default') ? x['default'] : x;
}

/**
 * Generates a unique ID.
 * @returns {string} The unique ID.
 */

var utils;
var hasRequiredUtils;

function requireUtils () {
	if (hasRequiredUtils) return utils;
	hasRequiredUtils = 1;
	function generateUniqueId() {
	  const timestamp = Date.now().toString(16);

	  let random;
	  try {
	    const { randomBytes } = require("crypto");
	    random = randomBytes(8).toString("hex");
	  } catch {
	    const arr = new Uint8Array(8);
	    crypto.getRandomValues(arr);
	    random = Array.from(arr).map(b => b.toString(16).padStart(2, "0")).join("");
	  }

	  return `${timestamp}${random}`.substring(0, 24);
	}

	/**
	 * Logs message to the console, with an optional type parameter to specify the log level.
	 * @param msg - Represents the message to log.
	 * @param type - Specifies the type of message. It can be either "error" or any other value.
	 */
	function logger(error, type) {
	  const msg = error instanceof Error ? error.message : error;

	  if (type === "error") {
	    console.error(msg);
	  } else {
	    console.log(msg);
	  }
	}

	utils = { generateUniqueId, logger };
	return utils;
}

/**
 * query.js — filter evaluation engine.
 *
 * matchesFilter(item, filter) → boolean
 * All conditions in filter use AND semantics (every key must match).
 *
 * Supported operators: $eq $ne $gt $gte $lt $lte $in $nin $regex $fn
 * Supported syntax: nested dot-notation, RegExp as direct value, function as filter
 */

var query;
var hasRequiredQuery;

function requireQuery () {
	if (hasRequiredQuery) return query;
	hasRequiredQuery = 1;
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

	query = { matchesFilter, presortFilter };
	return query;
}

/**
 * validator.js — lightweight schema validation, zero dependencies.
 *
 * Schema definition:
 *   { field: "type" }
 *   { field: { type: "string", required: true, unique: true, enum: [...] } }
 *
 * Supported types: "string", "number", "boolean", "object", "array", "date", "any"
 */

var validator;
var hasRequiredValidator;

function requireValidator () {
	if (hasRequiredValidator) return validator;
	hasRequiredValidator = 1;
	const SUPPORTED_TYPES = new Set(["string", "number", "boolean", "object", "array", "date", "any"]);

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
	        throw new Error(`Unknown schema type "${def}" for field "${key}"`);
	      }
	      fieldDef = { type: def, required: false, unique: false };
	    } else if (typeof def === "object" && def !== null) {
	      const { type = "any", required = false, unique = false, enum: enumVals } = def;
	      if (!SUPPORTED_TYPES.has(type)) {
	        throw new Error(`Unknown schema type "${type}" for field "${key}"`);
	      }
	      fieldDef = { type, required, unique, enum: enumVals };
	      if (unique) uniqueFields.push(key);
	    } else {
	      throw new Error(`Invalid schema definition for field "${key}"`);
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
	 * @returns {string[]}
	 */
	function validateDoc(doc, fields) {
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
	      const actualType = Array.isArray(val) ? "array" : (val instanceof Date ? "date" : typeof val);
	      if (actualType !== def.type) {
	        errors.push(`Field "${key}" must be of type "${def.type}", got "${actualType}"`);
	      }
	    }

	    if (def.enum && !def.enum.includes(val)) {
	      errors.push(`Field "${key}" must be one of [${def.enum.map(v => JSON.stringify(v)).join(", ")}], got ${JSON.stringify(val)}`);
	    }
	  }

	  return errors;
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
	    const t = Array.isArray(val) ? "array" : (val instanceof Date ? "date" : typeof val);
	    schema[key] = SUPPORTED_TYPES.has(t) ? t : "any";
	  }
	  return schema;
	}

	validator = { parseSchema, validateDoc, inferSchema };
	return validator;
}

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

var ttl;
var hasRequiredTtl;

function requireTtl () {
	if (hasRequiredTtl) return ttl;
	hasRequiredTtl = 1;
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

	ttl = { parseTtl, computeExpiry, sweep };
	return ttl;
}

/**
 * vector.js — cosine similarity and vector utilities.
 *
 * Vectors are stored inline on documents as `_vector: number[]`.
 * They are stripped from all query results automatically.
 */

var vector;
var hasRequiredVector;

function requireVector () {
	if (hasRequiredVector) return vector;
	hasRequiredVector = 1;
	/**
	 * Compute cosine similarity between two numeric vectors.
	 * Returns a value in [-1, 1]; 1 = identical direction, 0 = orthogonal.
	 * @param {number[]} a
	 * @param {number[]} b
	 * @returns {number}
	 */
	function cosineSimilarity(a, b) {
	  if (a.length !== b.length) {
	    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
	  }

	  let dot = 0, magA = 0, magB = 0;

	  for (let i = 0; i < a.length; i++) {
	    dot  += a[i] * b[i];
	    magA += a[i] * a[i];
	    magB += b[i] * b[i];
	  }

	  const denom = Math.sqrt(magA) * Math.sqrt(magB);
	  return denom === 0 ? 0 : dot / denom;
	}

	/**
	 * Return a shallow copy of a document with `_vector` removed.
	 * Used by all query methods so callers never see the raw vector.
	 * @param {object} doc
	 * @returns {object}
	 */
	function stripVector(doc) {
	  const copy = { ...doc };
	  delete copy._vector;
	  return copy;
	}

	vector = { cosineSimilarity, stripVector };
	return vector;
}

/**
 * aggregation.js — count / sum / avg / groupBy helpers.
 *
 * These are pure functions operating on a filtered doc array returned by
 * _findAllRaw(). They are called by the Collection methods of the same name.
 */

var aggregation;
var hasRequiredAggregation;

function requireAggregation () {
	if (hasRequiredAggregation) return aggregation;
	hasRequiredAggregation = 1;
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
	    const val = _getField(doc, field);
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
	    const val = _getField(doc, field);
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
	  const groups = {};
	  for (const doc of docs) {
	    const key = String(_getField(doc, field) ?? "__null__");
	    if (!groups[key]) groups[key] = [];
	    groups[key].push(doc);
	  }
	  return groups;
	}

	/**
	 * Dot-notation field accessor.
	 * @param {object} doc
	 * @param {string} field  - e.g. "address.city"
	 * @returns {unknown}
	 */
	function _getField(doc, field) {
	  const parts = field.split(".");
	  let cur = doc;
	  for (const p of parts) {
	    if (cur == null) return undefined;
	    cur = cur[p];
	  }
	  return cur;
	}

	aggregation = { count, sum, avg, groupBy };
	return aggregation;
}

var collection;
var hasRequiredCollection;

function requireCollection () {
	if (hasRequiredCollection) return collection;
	hasRequiredCollection = 1;
	const { generateUniqueId, logger } = requireUtils();
	const { matchesFilter, presortFilter } = requireQuery();
	const { validateDoc } = requireValidator();
	const { computeExpiry } = requireTtl();
	const { cosineSimilarity, stripVector } = requireVector();
	const { count: aggCount, sum: aggSum, avg: aggAvg, groupBy: aggGroupBy } = requireAggregation();

	/**
	 * Collection represents a collection of documents in the database.
	 */
	class Collection {
	  /**
	   * @param {object} collectionData - Internal store object managed by Skalex.
	   * @param {Skalex} database - The parent Skalex instance.
	   */
	  constructor(collectionData, database) {
	    this.name = collectionData.collectionName;
	    this.database = database;
	    this._store = collectionData;
	  }

	  get _data()  { return this._store.data; }
	  set _data(val) { this._store.data = val; }
	  get _index() { return this._store.index; }

	  /** @returns {import("./indexes")|null} Secondary field index engine. */
	  get _fieldIndex() { return this._store.fieldIndex || null; }

	  /** @returns {Map<string, object>|null} Parsed schema fields. */
	  get _schema() { return this._store.schema ? this._store.schema.fields : null; }

	  /** @returns {boolean} Whether changelog is enabled for this collection. */
	  get _changelogEnabled() { return this._store.changelog === true; }

	  // ─── Insert ──────────────────────────────────────────────────────────────

	  /**
	   * Insert a single document.
	   * @param {object} item
	   * @param {{ save?: boolean, ifNotExists?: boolean, ttl?: number|string, embed?: string|Function, session?: string }} [options]
	   * @returns {Promise<{ data: object }>}
	   */
	  async insertOne(item, options = {}) {
	    const { save, ifNotExists, ttl, embed, session } = options;

	    if (ifNotExists) {
	      const existing = this._findRaw(item);
	      if (existing) return { data: existing };
	    }

	    if (this._schema) {
	      const errors = validateDoc(item, this._schema);
	      if (errors.length) throw new Error(`Validation failed: ${errors.join("; ")}`);
	    }

	    await this.database._plugins.run("beforeInsert", { collection: this.name, doc: item });

	    const newItem = {
	      _id: generateUniqueId(),
	      createdAt: new Date(),
	      updatedAt: new Date(),
	      ...item,
	    };

	    if (ttl) newItem._expiresAt = computeExpiry(ttl);

	    if (embed) {
	      const text = typeof embed === "function" ? embed(newItem) : newItem[embed];
	      newItem._vector = await this.database.embed(String(text));
	    }

	    if (this._fieldIndex) this._fieldIndex.add(newItem);

	    this._data.push(newItem);
	    this._index.set(newItem._id, newItem);

	    if (save) await this.database.saveData(this.name);

	    if (this._changelogEnabled) {
	      await this.database._changeLog.log("insert", this.name, newItem, null, session || null);
	    }

	    this.database._sessionStats.recordWrite(session);
	    this.database._eventBus.emit(this.name, { op: "insert", collection: this.name, doc: stripVector(newItem) });

	    const result = { data: stripVector(newItem) };
	    await this.database._plugins.run("afterInsert", { collection: this.name, doc: result.data });
	    return result;
	  }

	  /**
	   * Insert multiple documents.
	   * @param {object[]} items
	   * @param {{ save?: boolean, ttl?: number|string, embed?: string|Function, session?: string }} [options]
	   * @returns {Promise<{ docs: object[] }>}
	   */
	  async insertMany(items, options = {}) {
	    const { save, ttl, embed, session } = options;

	    const newItems = [];
	    for (const item of items) {
	      if (this._schema) {
	        const errors = validateDoc(item, this._schema);
	        if (errors.length) throw new Error(`Validation failed: ${errors.join("; ")}`);
	      }

	      await this.database._plugins.run("beforeInsert", { collection: this.name, doc: item });

	      const newItem = {
	        _id: generateUniqueId(),
	        createdAt: new Date(),
	        updatedAt: new Date(),
	        ...item,
	      };

	      if (ttl) newItem._expiresAt = computeExpiry(ttl);

	      if (embed) {
	        const text = typeof embed === "function" ? embed(newItem) : newItem[embed];
	        newItem._vector = await this.database.embed(String(text));
	      }

	      newItems.push(newItem);
	    }

	    if (this._fieldIndex) {
	      for (const newItem of newItems) this._fieldIndex.add(newItem);
	    }

	    this._data.push(...newItems);
	    for (const newItem of newItems) this._index.set(newItem._id, newItem);

	    if (save) await this.database.saveData(this.name);

	    if (this._changelogEnabled) {
	      for (const newItem of newItems) {
	        await this.database._changeLog.log("insert", this.name, newItem, null, session || null);
	      }
	    }

	    this.database._sessionStats.recordWrite(session);
	    for (const newItem of newItems) {
	      const stripped = stripVector(newItem);
	      this.database._eventBus.emit(this.name, { op: "insert", collection: this.name, doc: stripped });
	      await this.database._plugins.run("afterInsert", { collection: this.name, doc: stripped });
	    }

	    return { docs: newItems.map(stripVector) };
	  }

	  // ─── Update ──────────────────────────────────────────────────────────────

	  /**
	   * Update the first matching document.
	   * @param {object} filter
	   * @param {object} update
	   * @param {{ save?: boolean, session?: string }} [options]
	   * @returns {Promise<{ data: object }|null>}
	   */
	  async updateOne(filter, update, options = {}) {
	    await this.database._plugins.run("beforeUpdate", { collection: this.name, filter, update });

	    const item = this._findRaw(filter);
	    if (!item) return null;

	    const prev = this._changelogEnabled ? { ...item } : null;

	    if (this._fieldIndex) this._fieldIndex.remove(item);
	    this.applyUpdate(item, update);
	    if (this._fieldIndex) this._fieldIndex.add(item);

	    if (options.save) await this.database.saveData(this.name);

	    if (this._changelogEnabled) {
	      await this.database._changeLog.log("update", this.name, item, prev, options.session || null);
	    }

	    this.database._sessionStats.recordWrite(options.session);
	    this.database._eventBus.emit(this.name, { op: "update", collection: this.name, doc: item, prev });

	    const result = { data: item };
	    await this.database._plugins.run("afterUpdate", { collection: this.name, filter, update, result: item });
	    return result;
	  }

	  /**
	   * Update all matching documents.
	   * @param {object} filter
	   * @param {object} update
	   * @param {{ save?: boolean, session?: string }} [options]
	   * @returns {Promise<{ docs: object[] }>}
	   */
	  async updateMany(filter, update, options = {}) {
	    await this.database._plugins.run("beforeUpdate", { collection: this.name, filter, update });

	    const items = this._findAllRaw(filter);
	    const prevs = this._changelogEnabled ? items.map(d => ({ ...d })) : null;

	    for (const item of items) {
	      if (this._fieldIndex) this._fieldIndex.remove(item);
	      this.applyUpdate(item, update);
	      if (this._fieldIndex) this._fieldIndex.add(item);
	    }

	    if (options.save) await this.database.saveData(this.name);

	    if (this._changelogEnabled) {
	      for (let i = 0; i < items.length; i++) {
	        await this.database._changeLog.log("update", this.name, items[i], prevs[i], options.session || null);
	      }
	    }

	    this.database._sessionStats.recordWrite(options.session);
	    for (const item of items) {
	      this.database._eventBus.emit(this.name, { op: "update", collection: this.name, doc: item });
	    }

	    await this.database._plugins.run("afterUpdate", { collection: this.name, filter, update, result: items });
	    return { docs: items };
	  }

	  /**
	   * Apply an update descriptor to a document in place.
	   * Supports $inc, $push, and direct assignment.
	   * @param {object} item
	   * @param {object} update
	   * @returns {object} The mutated document.
	   */
	  applyUpdate(item, update) {
	    for (const field in update) {
	      const updateValue = update[field];

	      if (typeof updateValue === "object" && updateValue !== null) {
	        for (const key in updateValue) {
	          if (key === "$inc" && typeof item[field] === "number") {
	            item[field] += updateValue[key];
	          } else if (key === "$push" && Array.isArray(item[field])) {
	            item[field].push(updateValue[key]);
	          } else if (!key.startsWith("$")) {
	            item[field] = updateValue;
	          }
	        }
	      } else {
	        item[field] = updateValue;
	      }
	    }

	    item.updatedAt = new Date();
	    this._index.set(item._id, item);

	    return item;
	  }

	  // ─── Upsert ──────────────────────────────────────────────────────────────

	  /**
	   * Update the first matching document, or insert if none exists.
	   * @param {object} filter
	   * @param {object} doc
	   * @param {{ save?: boolean }} [options]
	   * @returns {Promise<{ data: object }>}
	   */
	  async upsert(filter, doc, options = {}) {
	    const existing = this._findRaw(filter);
	    if (existing) {
	      return this.updateOne(filter, doc, options);
	    }
	    return this.insertOne({ ...filter, ...doc }, options);
	  }

	  // ─── Find ─────────────────────────────────────────────────────────────────

	  // ─── Watch ───────────────────────────────────────────────────────────────

	  /**
	   * Watch for mutation events on this collection.
	   *
	   * Callback form — returns an unsubscribe function:
	   *   const unsub = col.watch({ status: "active" }, event => console.log(event));
	   *   unsub(); // stop watching
	   *
	   * AsyncIterator form — no callback:
	   *   for await (const event of col.watch({ status: "active" })) { ... }
	   *
	   * Event shape: { op: "insert"|"update"|"delete", collection, doc, prev? }
	   *
	   * @param {object|Function} [filter]
	   * @param {Function} [callback]
	   * @returns {(() => void)|AsyncIterableIterator}
	   */
	  watch(filter, callback) {
	    // watch(callback) shorthand — no filter
	    if (typeof filter === "function") { callback = filter; filter = null; }

	    if (callback) {
	      // Callback-based API — returns unsub fn
	      return this.database._eventBus.on(this.name, event => {
	        if (!filter || matchesFilter(event.doc, filter)) callback(event);
	      });
	    }

	    // AsyncIterator API
	    return this._watchIterator(filter);
	  }

	  _watchIterator(filter) {
	    const queue   = [];
	    let   resolve = null;
	    let   done    = false;

	    const unsub = this.database._eventBus.on(this.name, event => {
	      if (filter && !matchesFilter(event.doc, filter)) return;
	      if (resolve) {
	        const r = resolve; resolve = null;
	        r({ value: event, done: false });
	      } else {
	        queue.push(event);
	      }
	    });

	    return {
	      [Symbol.asyncIterator]() { return this; },
	      next() {
	        if (queue.length > 0) return Promise.resolve({ value: queue.shift(), done: false });
	        if (done)             return Promise.resolve({ value: undefined, done: true });
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
	    return aggCount(this._findAllRaw(filter));
	  }

	  /**
	   * Sum a numeric field across matching documents.
	   * @param {string} field
	   * @param {object} [filter={}]
	   * @returns {Promise<number>}
	   */
	  async sum(field, filter = {}) {
	    return aggSum(this._findAllRaw(filter), field);
	  }

	  /**
	   * Average a numeric field across matching documents.
	   * Returns null when no matching numeric values exist.
	   * @param {string} field
	   * @param {object} [filter={}]
	   * @returns {Promise<number|null>}
	   */
	  async avg(field, filter = {}) {
	    return aggAvg(this._findAllRaw(filter), field);
	  }

	  /**
	   * Group matching documents by a field value.
	   * Returns `{ [value]: docs[] }`.
	   * @param {string} field
	   * @param {object} [filter={}]
	   * @returns {Promise<Record<string, object[]>>}
	   */
	  async groupBy(field, filter = {}) {
	    return aggGroupBy(this._findAllRaw(filter), field);
	  }

	  // ─── Find ─────────────────────────────────────────────────────────────────

	  /**
	   * Find the first matching document (returns a shallow copy with projection).
	   * @param {object} filter
	   * @param {{ populate?: string[], select?: string[] }} [options]
	   * @returns {Promise<object|null>}
	   */
	  async findOne(filter, options = {}) {
	    const { populate, select } = options;
	    const item = this._findRaw(filter);
	    if (!item) return null;

	    const newItem = {};

	    if (populate) {
	      for (const field of populate) {
	        const relatedCollection = this.database.useCollection(field);
	        const relatedItem = await relatedCollection.findOne({ _id: item[field] });
	        if (relatedItem) newItem[field] = relatedItem;
	      }
	    }

	    if (select) {
	      for (const field of select) newItem[field] = item[field];
	    } else {
	      Object.assign(newItem, item);
	      delete newItem._vector;
	    }

	    return newItem;
	  }

	  /**
	   * Find all matching documents.
	   * @param {object} filter
	   * @param {{ populate?: string[], select?: string[], sort?: object, page?: number, limit?: number }} [options]
	   * @returns {Promise<{ docs: object[], page?: number, totalDocs?: number, totalPages?: number }>}
	   */
	  async find(filter, options = {}) {
	    const _t0 = Date.now();
	    const { populate, select, sort, page = 1, limit, session } = options;

	    await this.database._plugins.run("beforeFind", { collection: this.name, filter, options });

	    const candidates = this._getCandidates(filter);
	    const sortedFilter = presortFilter(
	      filter,
	      this._fieldIndex ? this._fieldIndex.indexedFields : new Set()
	    );

	    let results = [];

	    for (const item of candidates) {
	      if (!matchesFilter(item, sortedFilter)) continue;

	      const newItem = {};

	      if (populate) {
	        for (const field of populate) {
	          const relatedCollection = this.database.useCollection(field);
	          const relatedItem = await relatedCollection.findOne({ [field]: item[field] });
	          if (relatedItem) newItem[field] = relatedItem;
	        }
	      }

	      if (select) {
	        for (const field of select) newItem[field] = item[field];
	      } else {
	        Object.assign(newItem, item);
	        delete newItem._vector;
	      }

	      results.push(newItem);
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

	    if (limit) {
	      const totalDocs = results.length;
	      const totalPages = Math.ceil(totalDocs / limit);
	      const startIndex = (page - 1) * limit;
	      results = results.slice(startIndex, startIndex + limit);
	      this.database._queryLog?.record({ collection: this.name, op: "find", filter, duration: Date.now() - _t0, resultCount: results.length });
	      this.database._sessionStats.recordRead(session);
	      await this.database._plugins.run("afterFind", { collection: this.name, filter, options, docs: results });
	      return { docs: results, page, totalDocs, totalPages };
	    }

	    this.database._queryLog?.record({ collection: this.name, op: "find", filter, duration: Date.now() - _t0, resultCount: results.length });
	    this.database._sessionStats.recordRead(session);
	    await this.database._plugins.run("afterFind", { collection: this.name, filter, options, docs: results });
	    return { docs: results };
	  }

	  // ─── Vector Search ───────────────────────────────────────────────────────

	  /**
	   * Semantic similarity search — embed a query string and rank all documents
	   * with a `_vector` field by cosine similarity.
	   *
	   * @param {string} query
	   * @param {{ filter?: object, limit?: number, minScore?: number }} [options]
	   * @returns {Promise<{ docs: object[], scores: number[] }>}
	   */
	  async search(query, { filter, limit = 10, minScore = 0, session } = {}) {
	    const _t0 = Date.now();
	    await this.database._plugins.run("beforeSearch", { collection: this.name, query, options: { filter, limit, minScore } });
	    const queryVector = await this.database.embed(query);

	    const candidates = filter ? this._findAllRaw(filter) : this._data;

	    const scored = [];
	    for (const doc of candidates) {
	      if (!doc._vector) continue;
	      const score = cosineSimilarity(queryVector, doc._vector);
	      if (score >= minScore) scored.push({ doc, score });
	    }

	    scored.sort((a, b) => b.score - a.score);
	    const top = scored.slice(0, limit);

	    this.database._queryLog?.record({ collection: this.name, op: "search", query, duration: Date.now() - _t0, resultCount: top.length });
	    this.database._sessionStats.recordRead(session);

	    const docs = top.map(r => stripVector(r.doc));
	    const scores = top.map(r => r.score);
	    await this.database._plugins.run("afterSearch", { collection: this.name, query, options: { filter, limit, minScore }, docs, scores });

	    return { docs, scores };
	  }

	  /**
	   * Find the nearest neighbours to an existing document by `_id`.
	   *
	   * @param {string} id
	   * @param {{ limit?: number, minScore?: number }} [options]
	   * @returns {Promise<{ docs: object[], scores: number[] }>}
	   */
	  async similar(id, { limit = 10, minScore = 0 } = {}) {
	    const source = this._index.get(id);
	    if (!source || !source._vector) return { docs: [], scores: [] };

	    const scored = [];
	    for (const doc of this._data) {
	      if (doc._id === id || !doc._vector) continue;
	      const score = cosineSimilarity(source._vector, doc._vector);
	      if (score >= minScore) scored.push({ doc, score });
	    }

	    scored.sort((a, b) => b.score - a.score);
	    const top = scored.slice(0, limit);

	    return {
	      docs: top.map(r => stripVector(r.doc)),
	      scores: top.map(r => r.score),
	    };
	  }

	  // ─── Delete ──────────────────────────────────────────────────────────────

	  /**
	   * Delete the first matching document.
	   * @param {object} filter
	   * @param {{ save?: boolean, session?: string }} [options]
	   * @returns {Promise<{ data: object }|null>}
	   */
	  async deleteOne(filter, options = {}) {
	    await this.database._plugins.run("beforeDelete", { collection: this.name, filter });

	    const index = this._findIndex(filter);
	    if (index === -1) return null;

	    const deletedItem = this._data.splice(index, 1)[0];
	    this._index.delete(deletedItem._id);
	    if (this._fieldIndex) this._fieldIndex.remove(deletedItem);

	    if (options.save) await this.database.saveData(this.name);

	    if (this._changelogEnabled) {
	      await this.database._changeLog.log("delete", this.name, deletedItem, null, options.session || null);
	    }

	    this.database._sessionStats.recordWrite(options.session);
	    this.database._eventBus.emit(this.name, { op: "delete", collection: this.name, doc: deletedItem });

	    await this.database._plugins.run("afterDelete", { collection: this.name, filter, result: deletedItem });
	    return { data: deletedItem };
	  }

	  /**
	   * Delete all matching documents.
	   * @param {object} filter
	   * @param {{ save?: boolean, session?: string }} [options]
	   * @returns {Promise<{ docs: object[] }>}
	   */
	  async deleteMany(filter, options = {}) {
	    await this.database._plugins.run("beforeDelete", { collection: this.name, filter });

	    const deletedItems = [];
	    const remainingItems = [];

	    for (const item of this._data) {
	      if (matchesFilter(item, filter)) {
	        deletedItems.push(item);
	        this._index.delete(item._id);
	        if (this._fieldIndex) this._fieldIndex.remove(item);
	      } else {
	        remainingItems.push(item);
	      }
	    }

	    this._data = remainingItems;

	    if (options.save) await this.database.saveData(this.name);

	    if (this._changelogEnabled) {
	      for (const deletedItem of deletedItems) {
	        await this.database._changeLog.log("delete", this.name, deletedItem, null, options.session || null);
	      }
	    }

	    this.database._sessionStats.recordWrite(options.session);
	    for (const deletedItem of deletedItems) {
	      this.database._eventBus.emit(this.name, { op: "delete", collection: this.name, doc: deletedItem });
	    }

	    await this.database._plugins.run("afterDelete", { collection: this.name, filter, result: deletedItems });
	    return { docs: deletedItems };
	  }

	  // ─── Export ──────────────────────────────────────────────────────────────

	  /**
	   * Export filtered data to a file via the storage adapter.
	   * @param {object} [filter={}]
	   * @param {{ dir?: string, name?: string, format?: "json"|"csv" }} [options]
	   */
	  async export(filter = {}, options = {}) {
	    const { dir, name, format = "json" } = options;

	    try {
	      const filteredData = this._data.filter(item => matchesFilter(item, filter));

	      if (filteredData.length === 0) {
	        throw new Error(`export(): no documents matched the filter in "${this.name}"`);
	      }

	      let content;
	      if (format === "json") {
	        content = JSON.stringify(filteredData, null, 2);
	      } else {
	        const header = Object.keys(filteredData[0]).join(",");
	        const rows = filteredData.map(item =>
	          Object.values(item).map(v =>
	            typeof v === "string" && v.includes(",") ? `"${v}"` : v
	          ).join(",")
	        );
	        content = [header, ...rows].join("\n");
	      }

	      const exportDir = dir || `${this.database.dataDirectory}/exports`;
	      const fileName = `${name || this.name}.${format}`;
	      const filePath = this.database.fs.join(exportDir, fileName);

	      this.database.fs.ensureDir(exportDir);
	      await this.database.fs.writeRaw(filePath, content);
	    } catch (error) {
	      logger(`Error exporting "${this.name}": ${error.message}`, "error");
	      throw error;
	    }
	  }

	  // ─── Backward-compat aliases ─────────────────────────────────────────────

	  /** @deprecated Use query.matchesFilter directly. Kept for backward compat. */
	  matchesFilter(item, filter) {
	    return matchesFilter(item, filter);
	  }

	  /** @deprecated Use _findIndex internally. Kept for backward compat. */
	  findIndex(filter) {
	    return this._findIndex(filter);
	  }

	  // ─── Private helpers ─────────────────────────────────────────────────────

	  _findRaw(filter) {
	    if (filter._id) {
	      const item = this._index.get(filter._id) || null;
	      if (item && Object.keys(filter).length > 1) {
	        return matchesFilter(item, filter) ? item : null;
	      }
	      return item;
	    }

	    // Try O(1) indexed field lookup first
	    if (this._fieldIndex) {
	      for (const key in filter) {
	        const val = filter[key];
	        if (typeof val !== "object" || val === null) {
	          const candidates = this._fieldIndex.lookup(key, val);
	          if (candidates !== null) {
	            for (const doc of candidates) {
	              if (matchesFilter(doc, filter)) return doc;
	            }
	            return null;
	          }
	        }
	      }
	    }

	    for (const doc of this._data) {
	      if (matchesFilter(doc, filter)) return doc;
	    }
	    return null;
	  }

	  _findAllRaw(filter) {
	    const results = [];
	    for (const doc of this._getCandidates(filter)) {
	      if (matchesFilter(doc, filter)) results.push(doc);
	    }
	    return results;
	  }

	  _getCandidates(filter) {
	    if (!this._fieldIndex) return this._data;
	    for (const key in filter) {
	      const val = filter[key];
	      if (typeof val !== "object" || val === null) {
	        const candidates = this._fieldIndex.lookup(key, val);
	        if (candidates !== null) return candidates;
	      }
	    }
	    return this._data;
	  }

	  _findIndex(filter) {
	    for (let i = 0; i < this._data.length; i++) {
	      if (matchesFilter(this._data[i], filter)) return i;
	    }
	    return -1;
	  }
	}

	collection = Collection;
	return collection;
}

/**
 * StorageAdapter — interface all storage backends must implement.
 *
 * All methods are async. `name` is a collection identifier string
 * (no path separators — the adapter maps it to its own storage scheme).
 */

var base$2;
var hasRequiredBase$2;

function requireBase$2 () {
	if (hasRequiredBase$2) return base$2;
	hasRequiredBase$2 = 1;
	class StorageAdapter {
	  /**
	   * Read a collection file. Returns the raw string content, or null if not found.
	   * @param {string} name
	   * @returns {Promise<string|null>}
	   */
	  async read(name) {
	    throw new Error("StorageAdapter.read() not implemented");
	  }

	  /**
	   * Write a collection. `data` is the serialised string to persist.
	   * @param {string} name
	   * @param {string} data
	   * @returns {Promise<void>}
	   */
	  async write(name, data) {
	    throw new Error("StorageAdapter.write() not implemented");
	  }

	  /**
	   * Delete a collection.
	   * @param {string} name
	   * @returns {Promise<void>}
	   */
	  async delete(name) {
	    throw new Error("StorageAdapter.delete() not implemented");
	  }

	  /**
	   * List all stored collection names.
	   * @returns {Promise<string[]>}
	   */
	  async list() {
	    throw new Error("StorageAdapter.list() not implemented");
	  }
	}

	base$2 = StorageAdapter;
	return base$2;
}

var fs;
var hasRequiredFs;

function requireFs () {
	if (hasRequiredFs) return fs;
	hasRequiredFs = 1;
	const nodePath = require$$0;
	const nodeFs = require$$1;
	const zlib = require$$2;
	const StorageAdapter = requireBase$2();

	/**
	 * FsAdapter — file-system storage for Node.js, Bun, and Deno.
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
	        raw = zlib.inflateSync(raw);
	      }
	      return raw.toString("utf8");
	    } catch (err) {
	      if (err.code === "ENOENT") return null;
	      throw err;
	    }
	  }

	  async write(name, data) {
	    this._ensureDir(this.dir);
	    const fp = this._filePath(name);
	    const tmp = nodePath.join(this.dir, `${name}_${Date.now()}.tmp.${this.format}`);

	    let output = data;
	    let encoding = "utf8";

	    if (this.format === "gz") {
	      output = zlib.deflateSync(data);
	      encoding = "binary";
	    }

	    await nodeFs.promises.writeFile(tmp, output, encoding);
	    await nodeFs.promises.rename(tmp, fp);
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

	  /** Utility: resolve a path relative to the data dir. */
	  resolve(p) {
	    return nodePath.resolve(p);
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
	}

	fs = FsAdapter;
	return fs;
}

/**
 * migrations.js — versioned schema migrations.
 *
 * Migrations are registered with db.addMigration({ version, up }).
 * On connect(), all pending migrations run in order, then state is saved to _meta.
 *
 * _meta collection stores: { _id: "migrations", appliedVersions: number[] }
 */

var migrations;
var hasRequiredMigrations;

function requireMigrations () {
	if (hasRequiredMigrations) return migrations;
	hasRequiredMigrations = 1;
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

	migrations = MigrationEngine;
	return migrations;
}

/**
 * indexes.js — secondary field index engine.
 *
 * Maintains Map-based indexes for declared fields.
 * - Indexed field lookups are O(1) instead of O(n).
 * - Unique indexes enforce no-duplicate constraint on insert/update.
 *
 * Index maps:
 *   fieldIndexes[field]: Map<fieldValue, Set<item>>
 *   uniqueIndexes[field]: Map<fieldValue, item>  (enforces uniqueness)
 */

var indexes;
var hasRequiredIndexes;

function requireIndexes () {
	if (hasRequiredIndexes) return indexes;
	hasRequiredIndexes = 1;
	class IndexEngine {
	  /**
	   * @param {string[]} fields   - Fields to index (non-unique)
	   * @param {string[]} unique   - Fields with unique constraint
	   */
	  constructor(fields = [], unique = []) {
	    this._fields = new Set(fields);
	    this._uniqueFields = new Set(unique);

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
	  }

	  /** Set of all indexed field names (union of regular + unique). */
	  get indexedFields() {
	    return new Set([...this._fields, ...this._uniqueFields]);
	  }

	  /**
	   * Build indexes from an existing data array (called on load).
	   * @param {object[]} data
	   */
	  buildFromData(data) {
	    // Reset
	    for (const [, m] of this._fieldIndexes) m.clear();
	    for (const [, m] of this._uniqueIndexes) m.clear();

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
	    this._indexDoc(newDoc);
	  }

	  /**
	   * Find all documents where field === value. Returns array (may be empty).
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
	  }

	  _checkUnique(newDoc, existingDoc) {
	    for (const field of this._uniqueFields) {
	      const val = newDoc[field];
	      if (val === undefined) continue;
	      const map = this._uniqueIndexes.get(field);
	      if (!map) continue;
	      const existing = map.get(val);
	      // Conflict only if there is an existing doc with this value
	      // and it"s NOT the same document being updated
	      if (existing && existing !== existingDoc) {
	        throw new Error(`Unique constraint violation: field "${field}" value "${val}" already exists`);
	      }
	    }
	  }
	}

	indexes = IndexEngine;
	return indexes;
}

/**
 * EmbeddingAdapter — interface all embedding backends must implement.
 *
 * embed(text) takes a string and returns a numeric vector (number[]).
 * Vectors are stored inline on documents as the `_vector` field and are
 * stripped from all query results so callers never see them directly.
 */

var base$1;
var hasRequiredBase$1;

function requireBase$1 () {
	if (hasRequiredBase$1) return base$1;
	hasRequiredBase$1 = 1;
	class EmbeddingAdapter {
	  /**
	   * Embed a text string into a numeric vector.
	   * @param {string} text
	   * @returns {Promise<number[]>}
	   */
	  async embed(text) {
	    throw new Error("EmbeddingAdapter.embed() not implemented");
	  }
	}

	base$1 = EmbeddingAdapter;
	return base$1;
}

/**
 * OpenAIEmbeddingAdapter — generates embeddings via the OpenAI API.
 *
 * Default model: text-embedding-3-small (1536 dimensions, fast and cheap).
 * Requires Node >=18 / Bun / Deno / browser (uses native fetch).
 */

var openai$1;
var hasRequiredOpenai$1;

function requireOpenai$1 () {
	if (hasRequiredOpenai$1) return openai$1;
	hasRequiredOpenai$1 = 1;
	const EmbeddingAdapter = requireBase$1();

	class OpenAIEmbeddingAdapter extends EmbeddingAdapter {
	  /**
	   * @param {object} config
	   * @param {string} config.apiKey            - OpenAI API key (required).
	   * @param {string} [config.model]           - Embedding model. Default: "text-embedding-3-small".
	   */
	  constructor({ apiKey, model = "text-embedding-3-small" } = {}) {
	    super();
	    if (!apiKey) throw new Error("OpenAIEmbeddingAdapter requires an apiKey");
	    this.apiKey = apiKey;
	    this.model = model;
	  }

	  async embed(text) {
	    const response = await fetch("https://api.openai.com/v1/embeddings", {
	      method: "POST",
	      headers: {
	        "Content-Type": "application/json",
	        "Authorization": `Bearer ${this.apiKey}`,
	      },
	      body: JSON.stringify({ input: text, model: this.model }),
	    });

	    if (!response.ok) {
	      const err = await response.text();
	      throw new Error(`OpenAI embedding API error ${response.status}: ${err}`);
	    }

	    const data = await response.json();
	    return data.data[0].embedding;
	  }
	}

	openai$1 = OpenAIEmbeddingAdapter;
	return openai$1;
}

/**
 * OllamaEmbeddingAdapter — generates embeddings via a local Ollama server.
 *
 * Default model: nomic-embed-text (768 dimensions).
 * Default host:  http://localhost:11434
 *
 * Run locally with: ollama pull nomic-embed-text
 */

var ollama$1;
var hasRequiredOllama$1;

function requireOllama$1 () {
	if (hasRequiredOllama$1) return ollama$1;
	hasRequiredOllama$1 = 1;
	const EmbeddingAdapter = requireBase$1();

	class OllamaEmbeddingAdapter extends EmbeddingAdapter {
	  /**
	   * @param {object} [config]
	   * @param {string} [config.model]  - Ollama model name. Default: "nomic-embed-text".
	   * @param {string} [config.host]   - Ollama server URL. Default: "http://localhost:11434".
	   */
	  constructor({ model = "nomic-embed-text", host = "http://localhost:11434" } = {}) {
	    super();
	    this.model = model;
	    this.host = host;
	  }

	  async embed(text) {
	    const response = await fetch(`${this.host}/api/embeddings`, {
	      method: "POST",
	      headers: { "Content-Type": "application/json" },
	      body: JSON.stringify({ model: this.model, prompt: text }),
	    });

	    if (!response.ok) {
	      const err = await response.text();
	      throw new Error(`Ollama embedding API error ${response.status}: ${err}`);
	    }

	    const data = await response.json();
	    return data.embedding;
	  }
	}

	ollama$1 = OllamaEmbeddingAdapter;
	return ollama$1;
}

/**
 * AIAdapter — interface all language model backends must implement.
 *
 * Used by:
 *   - db.ask(question, collection)  — NL → filter translation
 *   - memory.compress()             — memory summarisation
 */

var base;
var hasRequiredBase;

function requireBase () {
	if (hasRequiredBase) return base;
	hasRequiredBase = 1;
	class AIAdapter {
	  /**
	   * Translate a natural language query into a Skalex filter object.
	   * @param {object} schema   - Plain { field: type } schema of the target collection.
	   * @param {string} nlQuery  - Natural language query string.
	   * @returns {Promise<object>} A filter object compatible with matchesFilter().
	   */
	  async generate(schema, nlQuery) {
	    throw new Error("AIAdapter.generate() not implemented");
	  }

	  /**
	   * Summarise multiple memory text entries into a single paragraph.
	   * @param {string} texts  - Newline-separated memory entries.
	   * @returns {Promise<string>}
	   */
	  async summarize(texts) {
	    throw new Error("AIAdapter.summarize() not implemented");
	  }
	}

	base = AIAdapter;
	return base;
}

/**
 * OpenAIAIAdapter — language model adapter using the OpenAI Chat API.
 *
 * Default model: gpt-4o-mini (fast, cheap, supports JSON mode).
 * Uses native fetch — no additional dependencies.
 */

var openai;
var hasRequiredOpenai;

function requireOpenai () {
	if (hasRequiredOpenai) return openai;
	hasRequiredOpenai = 1;
	const AIAdapter = requireBase();

	const SYSTEM_GENERATE = [
	  "You are a database query translator.",
	  "Given a JSON schema and a natural language query, return a valid JSON filter object.",
	  "Only reference fields that exist in the schema.",
	  "Supported operators: $eq, $ne, $gt, $gte, $lt, $lte, $in, $nin.",
	  'For regex: { "field": { "$regex": "pattern" } } — value must be a string.',
	  "For date comparisons use ISO 8601 strings.",
	  "Return ONLY the JSON object. No explanation, no markdown.",
	].join("\n");

	class OpenAIAIAdapter extends AIAdapter {
	  /**
	   * @param {object} config
	   * @param {string} config.apiKey  - OpenAI API key (required).
	   * @param {string} [config.model] - Chat model. Default: "gpt-4o-mini".
	   */
	  constructor({ apiKey, model = "gpt-4o-mini" } = {}) {
	    super();
	    if (!apiKey) throw new Error("OpenAIAIAdapter requires an apiKey");
	    this.apiKey = apiKey;
	    this.model = model;
	  }

	  async generate(schema, nlQuery) {
	    const response = await fetch("https://api.openai.com/v1/chat/completions", {
	      method: "POST",
	      headers: {
	        "Content-Type": "application/json",
	        "Authorization": `Bearer ${this.apiKey}`,
	      },
	      body: JSON.stringify({
	        model: this.model,
	        messages: [
	          { role: "system", content: `${SYSTEM_GENERATE}\nSchema: ${JSON.stringify(schema)}` },
	          { role: "user", content: nlQuery },
	        ],
	        response_format: { type: "json_object" },
	        temperature: 0,
	      }),
	    });

	    if (!response.ok) {
	      const err = await response.text();
	      throw new Error(`OpenAI API error ${response.status}: ${err}`);
	    }

	    const data = await response.json();
	    return JSON.parse(data.choices[0].message.content);
	  }

	  async summarize(texts) {
	    const response = await fetch("https://api.openai.com/v1/chat/completions", {
	      method: "POST",
	      headers: {
	        "Content-Type": "application/json",
	        "Authorization": `Bearer ${this.apiKey}`,
	      },
	      body: JSON.stringify({
	        model: this.model,
	        messages: [
	          {
	            role: "system",
	            content: "Summarise the following memory entries into one concise paragraph. Preserve all important facts.",
	          },
	          { role: "user", content: texts },
	        ],
	        temperature: 0.3,
	      }),
	    });

	    if (!response.ok) {
	      const err = await response.text();
	      throw new Error(`OpenAI API error ${response.status}: ${err}`);
	    }

	    const data = await response.json();
	    return data.choices[0].message.content.trim();
	  }
	}

	openai = OpenAIAIAdapter;
	return openai;
}

/**
 * AnthropicAIAdapter — language model adapter using the Anthropic Messages API.
 *
 * Default model: claude-haiku-4-5 (fast and economical).
 * Uses native fetch — no additional dependencies.
 */

var anthropic;
var hasRequiredAnthropic;

function requireAnthropic () {
	if (hasRequiredAnthropic) return anthropic;
	hasRequiredAnthropic = 1;
	const AIAdapter = requireBase();

	const SYSTEM_GENERATE = [
	  "You are a database query translator.",
	  "Given a JSON schema and a natural language query, return a valid JSON filter object.",
	  "Only reference fields that exist in the schema.",
	  "Supported operators: $eq, $ne, $gt, $gte, $lt, $lte, $in, $nin.",
	  'For regex: { "field": { "$regex": "pattern" } } — value must be a string.',
	  "For date comparisons use ISO 8601 strings.",
	  "Return ONLY the JSON object. No explanation, no markdown, no code fences.",
	].join("\n");

	class AnthropicAIAdapter extends AIAdapter {
	  /**
	   * @param {object} config
	   * @param {string} config.apiKey  - Anthropic API key (required).
	   * @param {string} [config.model] - Model. Default: "claude-haiku-4-5".
	   */
	  constructor({ apiKey, model = "claude-haiku-4-5" } = {}) {
	    super();
	    if (!apiKey) throw new Error("AnthropicAIAdapter requires an apiKey");
	    this.apiKey = apiKey;
	    this.model = model;
	  }

	  async generate(schema, nlQuery) {
	    const response = await fetch("https://api.anthropic.com/v1/messages", {
	      method: "POST",
	      headers: {
	        "Content-Type": "application/json",
	        "x-api-key": this.apiKey,
	        "anthropic-version": "2023-06-01",
	      },
	      body: JSON.stringify({
	        model: this.model,
	        max_tokens: 1024,
	        system: `${SYSTEM_GENERATE}\nSchema: ${JSON.stringify(schema)}`,
	        messages: [{ role: "user", content: nlQuery }],
	      }),
	    });

	    if (!response.ok) {
	      const err = await response.text();
	      throw new Error(`Anthropic API error ${response.status}: ${err}`);
	    }

	    const data = await response.json();
	    const text = data.content[0].text.trim()
	      .replace(/^```(?:json)?\n?/, "")
	      .replace(/\n?```$/, "");
	    return JSON.parse(text);
	  }

	  async summarize(texts) {
	    const response = await fetch("https://api.anthropic.com/v1/messages", {
	      method: "POST",
	      headers: {
	        "Content-Type": "application/json",
	        "x-api-key": this.apiKey,
	        "anthropic-version": "2023-06-01",
	      },
	      body: JSON.stringify({
	        model: this.model,
	        max_tokens: 512,
	        system: "Summarise the following memory entries into one concise paragraph. Preserve all important facts.",
	        messages: [{ role: "user", content: texts }],
	      }),
	    });

	    if (!response.ok) {
	      const err = await response.text();
	      throw new Error(`Anthropic API error ${response.status}: ${err}`);
	    }

	    const data = await response.json();
	    return data.content[0].text.trim();
	  }
	}

	anthropic = AnthropicAIAdapter;
	return anthropic;
}

/**
 * OllamaAIAdapter — language model adapter using a local Ollama server.
 *
 * Default model: llama3.2
 * Default host:  http://localhost:11434
 *
 * Run locally: ollama pull llama3.2
 */

var ollama;
var hasRequiredOllama;

function requireOllama () {
	if (hasRequiredOllama) return ollama;
	hasRequiredOllama = 1;
	const AIAdapter = requireBase();

	class OllamaAIAdapter extends AIAdapter {
	  /**
	   * @param {object} [config]
	   * @param {string} [config.model] - Ollama model name. Default: "llama3.2".
	   * @param {string} [config.host]  - Ollama server URL. Default: "http://localhost:11434".
	   */
	  constructor({ model = "llama3.2", host = "http://localhost:11434" } = {}) {
	    super();
	    this.model = model;
	    this.host = host;
	  }

	  async generate(schema, nlQuery) {
	    const prompt = [
	      "You are a database query translator.",
	      "Given a JSON schema and a natural language query, return a valid JSON filter object.",
	      "Only reference fields that exist in the schema.",
	      "Supported operators: $eq, $ne, $gt, $gte, $lt, $lte, $in, $nin.",
	      'For regex: { "field": { "$regex": "pattern" } } — value must be a string.',
	      "Return ONLY the JSON object. No explanation.",
	      `Schema: ${JSON.stringify(schema)}`,
	      `Query: ${nlQuery}`,
	      "JSON filter:",
	    ].join("\n");

	    const response = await fetch(`${this.host}/api/generate`, {
	      method: "POST",
	      headers: { "Content-Type": "application/json" },
	      body: JSON.stringify({ model: this.model, prompt, format: "json", stream: false }),
	    });

	    if (!response.ok) {
	      const err = await response.text();
	      throw new Error(`Ollama API error ${response.status}: ${err}`);
	    }

	    const data = await response.json();
	    return JSON.parse(data.response);
	  }

	  async summarize(texts) {
	    const response = await fetch(`${this.host}/api/generate`, {
	      method: "POST",
	      headers: { "Content-Type": "application/json" },
	      body: JSON.stringify({
	        model: this.model,
	        prompt: `Summarise the following memory entries into one concise paragraph. Preserve all important facts.\n\n${texts}`,
	        stream: false,
	      }),
	    });

	    if (!response.ok) {
	      const err = await response.text();
	      throw new Error(`Ollama API error ${response.status}: ${err}`);
	    }

	    const data = await response.json();
	    return data.response.trim();
	  }
	}

	ollama = OllamaAIAdapter;
	return ollama;
}

/**
 * EncryptedAdapter — wraps any StorageAdapter with AES-256-GCM encryption.
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
 * Node.js ≥18, Bun, Deno, and all modern browsers — no extra dependencies.
 *
 * Key formats accepted:
 *   - 64-character hex string  (32 bytes)
 *   - Uint8Array / Buffer      (32 bytes)
 */

var encrypted;
var hasRequiredEncrypted;

function requireEncrypted () {
	if (hasRequiredEncrypted) return encrypted;
	hasRequiredEncrypted = 1;
	const StorageAdapter = requireBase$2();

	const ALGO    = "AES-GCM";
	const IV_LEN  = 12;   // bytes — recommended for GCM
	const KEY_LEN = 32;   // bytes — AES-256

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
	      throw new Error(
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

	  // ─── FsAdapter extension passthrough ────────────────────────────────────────
	  // These stubs forward optional FsAdapter-specific methods (used by export/import).

	  join(...args) { return this._adapter.join?.(...args); }
	  ensureDir(dir) { return this._adapter.ensureDir?.(dir); }

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
	    const encoded = new TextEncoder().encode(plaintext);

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

	    return new TextDecoder().decode(plainBuf);
	  }
	}

	// ─── Helpers ──────────────────────────────────────────────────────────────────

	function _hexToBytes(hex) {
	  if (hex.length !== KEY_LEN * 2) {
	    throw new Error(
	      `EncryptedAdapter: hex key must be ${KEY_LEN * 2} characters (${KEY_LEN} bytes)`
	    );
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

	encrypted = EncryptedAdapter;
	return encrypted;
}

/**
 * memory.js — episodic agent memory.
 *
 * A Memory instance wraps a private _memory_<sessionId> collection and provides:
 *   remember  — store a text entry with an embedding
 *   recall    — semantic search over stored memories
 *   history   — chronological listing
 *   forget    — delete a specific entry
 *   context   — LLM-ready string within a token budget
 *   tokenCount — estimate token usage
 *   compress  — summarise and compact old entries via the language model
 *
 * Requires:
 *   - An embedding adapter (db._embeddingAdapter) for remember() and recall()
 *   - A language model adapter (db._aiAdapter) for compress()
 */

var memory;
var hasRequiredMemory;

function requireMemory () {
	if (hasRequiredMemory) return memory;
	hasRequiredMemory = 1;
	class Memory {
	  /**
	   * @param {string} sessionId
	   * @param {object} db  - Skalex instance
	   */
	  constructor(sessionId, db) {
	    this.sessionId = sessionId;
	    this._db = db;
	    this._col = db.useCollection(`_memory_${sessionId}`);
	  }

	  /**
	   * Store a text memory. Embeds the text for later semantic recall.
	   * @param {string} text
	   * @returns {Promise<{ data: object }>}
	   */
	  async remember(text) {
	    return this._col.insertOne(
	      { text, sessionId: this.sessionId },
	      { embed: "text" }
	    );
	  }

	  /**
	   * Recall the most semantically relevant memories for a query.
	   * @param {string} query
	   * @param {{ limit?: number, minScore?: number }} [opts]
	   * @returns {Promise<{ docs: object[], scores: number[] }>}
	   */
	  async recall(query, { limit = 10, minScore = 0 } = {}) {
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
	   * @returns {Promise<{ data: object }|null>}
	   */
	  async forget(id) {
	    return this._col.deleteOne({ _id: id });
	  }

	  /**
	   * Estimate the token count of all stored memories (chars / 4 heuristic).
	   * @returns {{ tokens: number, count: number }}
	   */
	  tokenCount() {
	    const data = this._col._data;
	    const tokens = data.reduce((sum, d) => sum + Math.ceil((d.text || "").length / 4), 0);
	    return { tokens, count: data.length };
	  }

	  /**
	   * Return memories as a newline-joined string, newest-first, capped to a token budget.
	   * @param {{ tokens?: number }} [opts]
	   * @returns {string}
	   */
	  context({ tokens = 4000 } = {}) {
	    const sorted = [...this._col._data].sort(
	      (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
	    );

	    const lines = [];
	    let used = 0;

	    for (const doc of sorted) {
	      const t = Math.ceil((doc.text || "").length / 4);
	      if (used + t > tokens) break;
	      lines.push(doc.text);
	      used += t;
	    }

	    return lines.reverse().join("\n");
	  }

	  /**
	   * Summarise and compact old memories when total tokens exceed a threshold.
	   * Keeps the 10 most recent entries intact; summarises the rest into one entry.
	   * @param {{ threshold?: number }} [opts]
	   * @returns {Promise<void>}
	   */
	  async compress({ threshold = 8000 } = {}) {
	    const { tokens } = this.tokenCount();
	    if (tokens <= threshold) return;

	    if (!this._db._aiAdapter) {
	      throw new Error(
	        "memory.compress() requires a language model adapter. Configure { ai: { model: \"...\" } }."
	      );
	    }

	    const sorted = [...this._col._data].sort(
	      (a, b) => new Date(a.createdAt) - new Date(b.createdAt)
	    );

	    const splitAt = Math.max(0, sorted.length - 10);
	    const toCompress = sorted.slice(0, splitAt);
	    if (toCompress.length === 0) return;

	    const texts = toCompress.map(d => d.text).join("\n");
	    const summary = await this._db._aiAdapter.summarize(texts);

	    for (const doc of toCompress) {
	      await this._col.deleteOne({ _id: doc._id });
	    }

	    await this._col.insertOne({
	      text: summary,
	      sessionId: this.sessionId,
	      compressed: true,
	    });
	  }
	}

	memory = Memory;
	return memory;
}

/**
 * changelog.js — per-collection append-only mutation log.
 *
 * When a collection is created with { changelog: true }, every insert,
 * update, and delete is recorded in a shared _changelog collection.
 *
 * Entry shape:
 *   { op, collection, docId, doc, prev?, timestamp, session? }
 */

var changelog;
var hasRequiredChangelog;

function requireChangelog () {
	if (hasRequiredChangelog) return changelog;
	hasRequiredChangelog = 1;
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

	changelog = ChangeLog;
	return changelog;
}

/**
 * ask.js — query cache and LLM filter utilities for db.ask().
 */

var ask;
var hasRequiredAsk;

function requireAsk () {
	if (hasRequiredAsk) return ask;
	hasRequiredAsk = 1;
	// ─── Hash ─────────────────────────────────────────────────────────────────────

	/**
	 * Deterministic djb2-style hash of a string.
	 * @param {string} str
	 * @returns {string} 8-char hex
	 */
	function _djb2(str) {
	  let h = 5381;
	  for (let i = 0; i < str.length; i++) {
	    h = Math.imul((h << 5) + h, 1) + str.charCodeAt(i) | 0;
	  }
	  return (h >>> 0).toString(16).padStart(8, "0");
	}

	// ─── QueryCache ───────────────────────────────────────────────────────────────

	/**
	 * QueryCache — maps hash(collection + schema + query) → filter object.
	 *
	 * Persisted in the _meta collection so it survives connect/disconnect cycles.
	 * The cache avoids calling the LLM again for the same question on the same schema.
	 */
	class QueryCache {
	  constructor() {
	    this._cache = new Map();
	  }

	  _key(collectionName, schema, query) {
	    return _djb2(JSON.stringify({ collectionName, schema, query }));
	  }

	  get(collectionName, schema, query) {
	    return this._cache.get(this._key(collectionName, schema, query));
	  }

	  set(collectionName, schema, query, filter) {
	    this._cache.set(this._key(collectionName, schema, query), filter);
	  }

	  toJSON() {
	    return Object.fromEntries(this._cache);
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
	 * @returns {object}
	 */
	function processLLMFilter(filter) {
	  if (typeof filter !== "object" || filter === null) return filter;

	  const result = {};
	  for (const key of Object.keys(filter)) {
	    const val = filter[key];
	    if (val && typeof val === "object" && !Array.isArray(val)) {
	      const processed = {};
	      for (const op of Object.keys(val)) {
	        if (op === "$regex" && typeof val.$regex === "string") {
	          processed.$regex = new RegExp(val.$regex);
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
	 * Returns warning strings for unknown fields — does not throw.
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

	ask = { QueryCache, processLLMFilter, validateLLMFilter };
	return ask;
}

/**
 * events.js — lightweight cross-runtime event bus.
 *
 * Provides pub/sub for collection mutation events consumed by watch() and
 * any other internal subscribers. No Node.js EventEmitter dependency —
 * works identically in Node, Bun, Deno, and browsers.
 *
 * Event names are collection names. Subscribers receive a MutationEvent:
 *   { op, collection, doc, prev? }
 */

var events;
var hasRequiredEvents;

function requireEvents () {
	if (hasRequiredEvents) return events;
	hasRequiredEvents = 1;
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
	   * Emit an event to all subscribers. Errors in listeners are swallowed
	   * to prevent a bad subscriber from breaking a mutation.
	   * @param {string} event
	   * @param {object} data
	   */
	  emit(event, data) {
	    const fns = this._listeners.get(event);
	    if (!fns) return;
	    for (const fn of fns) {
	      try { fn(data); } catch (_) { /* swallow — watcher errors must not break writes */ }
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

	events = EventBus;
	return events;
}

/**
 * query-log.js — slow query log for find / search operations.
 *
 * Queries whose duration exceeds `threshold` ms are recorded.
 * Call db.slowQueries(opts) to retrieve them.
 *
 * Entry shape:
 *   { collection, op, filter?, query?, duration, resultCount, timestamp }
 */

var queryLog;
var hasRequiredQueryLog;

function requireQueryLog () {
	if (hasRequiredQueryLog) return queryLog;
	hasRequiredQueryLog = 1;
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

	  /** Clear all recorded entries. */
	  clear() {
	    this._entries = [];
	  }

	  /** @returns {number} */
	  get size() {
	    return this._entries.length;
	  }
	}

	queryLog = QueryLog;
	return queryLog;
}

/**
 * SessionStats — per-session read/write/lastActive tracking.
 *
 * Sessions are keyed by an arbitrary string ID passed via the `session`
 * option on mutation methods and find/search options.
 */

var sessionStats;
var hasRequiredSessionStats;

function requireSessionStats () {
	if (hasRequiredSessionStats) return sessionStats;
	hasRequiredSessionStats = 1;
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

	sessionStats = SessionStats;
	return sessionStats;
}

/**
 * PluginEngine — pre/post hook system for all database operations.
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
 *   afterInsert   : { collection, doc }           — doc is the fully inserted document
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

var plugins;
var hasRequiredPlugins;

function requirePlugins () {
	if (hasRequiredPlugins) return plugins;
	hasRequiredPlugins = 1;
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
	      throw new TypeError("Plugin must be a non-null object.");
	    }
	    this._plugins.push(plugin);
	  }

	  /**
	   * Run all registered handlers for a given hook name.
	   * @param {string} hook - e.g. "beforeInsert"
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

	plugins = PluginEngine;
	return plugins;
}

/**
 * tools.js — MCP tool definitions and handlers for Skalex.
 *
 * Each tool exposes one Skalex operation to an AI agent.
 * The handler receives (db, args) and returns a plain value that is
 * JSON-serialised into the MCP content text.
 *
 * Tools:
 *   collections — list all collections
 *   schema      — get schema for a collection
 *   find        — find documents
 *   insert      — insert a document
 *   update      — update matching documents
 *   delete      — delete matching documents
 *   search      — semantic similarity search (requires embedding adapter)
 *   ask         — natural-language query (requires AI adapter)
 *
 * Scopes:
 *   read  — collections, schema, find, search, ask
 *   write — insert, update, delete
 */

var tools;
var hasRequiredTools;

function requireTools () {
	if (hasRequiredTools) return tools;
	hasRequiredTools = 1;
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
	 * @returns {Promise<object>} Plain value to be JSON.stringify'd into content text.
	 */
	async function callTool(name, args, db) {
	  switch (name) {
	    case "skalex_collections":
	      return Object.keys(db.collections);

	    case "skalex_schema": {
	      const s = db.schema(args.collection);
	      return s ?? null;
	    }

	    case "skalex_find": {
	      const col = db.useCollection(args.collection);
	      const opts = {};
	      if (args.limit) opts.limit = args.limit;
	      if (args.sort)  opts.sort  = args.sort;
	      return col.find(args.filter || {}, opts);
	    }

	    case "skalex_insert": {
	      const col = db.useCollection(args.collection);
	      return col.insertOne(args.doc || {});
	    }

	    case "skalex_update": {
	      const col = db.useCollection(args.collection);
	      if (args.many) return col.updateMany(args.filter || {}, args.update || {});
	      return col.updateOne(args.filter || {}, args.update || {});
	    }

	    case "skalex_delete": {
	      const col = db.useCollection(args.collection);
	      if (args.many) return col.deleteMany(args.filter || {});
	      return col.deleteOne(args.filter || {});
	    }

	    case "skalex_search": {
	      const col = db.useCollection(args.collection);
	      return col.search(args.query, {
	        limit:    args.limit    ?? 10,
	        minScore: args.minScore ?? 0,
	        filter:   args.filter,
	      });
	    }

	    case "skalex_ask":
	      return db.ask(args.collection, args.question, { limit: args.limit ?? 20 });

	    default:
	      throw Object.assign(new Error(`Unknown tool: ${name}`), { code: "NOT_FOUND" });
	  }
	}

	tools = { TOOL_DEFS, callTool };
	return tools;
}

/**
 * protocol.js — JSON-RPC 2.0 helpers for the MCP server.
 *
 * MCP (Model Context Protocol) uses JSON-RPC 2.0 as its wire format.
 * These helpers build compliant response/error objects and parse incoming
 * messages without any external dependencies.
 */

var protocol;
var hasRequiredProtocol;

function requireProtocol () {
	if (hasRequiredProtocol) return protocol;
	hasRequiredProtocol = 1;
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
	  if (data !== undefined) err.data = data;
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

	protocol = {
	  ok,
	  error,
	  parse,
	  toolResult,
	  toolError,
	  PARSE_ERROR,
	  INVALID_REQUEST,
	  METHOD_NOT_FOUND,
	  INVALID_PARAMS,
	  INTERNAL_ERROR,
	};
	return protocol;
}

/**
 * transports/http.js — HTTP + SSE transport for the MCP server.
 *
 * Implements the MCP HTTP/SSE transport:
 *   GET  /sse      — establishes a persistent SSE stream (server → client)
 *   POST /message  — receives JSON-RPC requests from the client
 *
 * Uses Node's built-in `http` module — zero extra dependencies.
 *
 * Multiple simultaneous SSE clients are supported; each receives all
 * server-sent messages (broadcast model).
 */

var http_1;
var hasRequiredHttp;

function requireHttp () {
	if (hasRequiredHttp) return http_1;
	hasRequiredHttp = 1;
	const http = require$$0$1;

	class HttpTransport {
	  /**
	   * @param {{ port?: number, host?: string }} [opts]
	   */
	  constructor({ port = 3000, host = "127.0.0.1" } = {}) {
	    this._port    = port;
	    this._host    = host;
	    this._clients = new Set(); // active SSE response objects
	    this._onMessage = null;
	    this._server  = null;
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
	        // CORS headers for browser clients
	        res.setHeader("Access-Control-Allow-Origin", "*");
	        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	        res.setHeader("Access-Control-Allow-Headers", "Content-Type");

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
	    req.on("data", c => { body += c; });
	    req.on("end", async () => {
	      res.writeHead(202, { "Content-Type": "application/json" });
	      res.end("{}");

	      let msg;
	      try {
	        msg = JSON.parse(body);
	      } catch (_) {
	        const { error, PARSE_ERROR } = requireProtocol();
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

	http_1 = HttpTransport;
	return http_1;
}

/**
 * transports/stdio.js — stdio transport for the MCP server.
 *
 * Reads newline-delimited JSON-RPC messages from stdin and writes
 * responses to stdout. This is the standard MCP transport used by
 * Claude Desktop, Cursor, and other AI tools that spawn local servers.
 *
 * Protocol:
 *   stdin  → one JSON object per line (client → server)
 *   stdout → one JSON object per line (server → client)
 */

var stdio;
var hasRequiredStdio;

function requireStdio () {
	if (hasRequiredStdio) return stdio;
	hasRequiredStdio = 1;
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
	            const { error, PARSE_ERROR } = requireProtocol();
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

	stdio = StdioTransport;
	return stdio;
}

/**
 * mcp/index.js — SkalexMCPServer
 *
 * Exposes a Skalex database as a set of MCP tools that AI agents (Claude
 * Desktop, Cursor, OpenClaw, custom agents) can call via the Model Context
 * Protocol.
 *
 * Instantiate via db.mcp(opts) — do not construct directly.
 *
 * Transports:
 *   stdio (default) — newline-delimited JSON on stdin/stdout
 *   http            — HTTP server + SSE stream
 *
 * Access control:
 *   scopes: { collectionName | '*': ['read'] | ['read', 'write'] }
 *   'read'  — find, search, ask, schema, collections
 *   'write' — insert, update, delete
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

var mcp;
var hasRequiredMcp;

function requireMcp () {
	if (hasRequiredMcp) return mcp;
	hasRequiredMcp = 1;
	const { TOOL_DEFS, callTool } = requireTools();
	const { ok, error, parse, toolResult, toolError, METHOD_NOT_FOUND, INVALID_PARAMS, INTERNAL_ERROR } = requireProtocol();

	const SERVER_INFO = { name: "skalex", version: "4.0.0-alpha" };
	const PROTOCOL_VERSION = "2024-11-05";

	class SkalexMCPServer {
	  /**
	   * @param {object} db                           - Skalex instance.
	   * @param {object} [opts]
	   * @param {"stdio"|"http"} [opts.transport]     - Transport type. Default: "stdio".
	   * @param {number}  [opts.port]                 - HTTP port. Default: 3000.
	   * @param {string}  [opts.host]                 - HTTP host. Default: "127.0.0.1".
	   * @param {object}  [opts.scopes]               - Access control map. Default: { "*": ["read", "write"] }.
	   */
	  constructor(db, opts = {}) {
	    this._db        = db;
	    this._transport = opts.transport || "stdio";
	    this._port      = opts.port      || 3000;
	    this._host      = opts.host      || "127.0.0.1";
	    this._scopes    = opts.scopes    || { "*": ["read", "write"] };
	    this._t         = null; // active transport instance
	    this._initialized = false;
	  }

	  // ─── Public API ────────────────────────────────────────────────────────────

	  /**
	   * Start listening on the configured transport.
	   * @returns {Promise<void>}
	   */
	  async listen() {
	    if (this._transport === "http") {
	      const HttpTransport = requireHttp();
	      this._t = new HttpTransport({ port: this._port, host: this._host });
	    } else {
	      const StdioTransport = requireStdio();
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
	    this._initialized = false;
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

	    // Notifications (no id) — acknowledge silently
	    if (id === undefined) {
	      if (method === "notifications/initialized") this._initialized = true;
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
	      const result = await callTool(name, args, this._db);
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

	mcp = SkalexMCPServer;
	return mcp;
}

var src;
var hasRequiredSrc;

function requireSrc () {
	if (hasRequiredSrc) return src;
	hasRequiredSrc = 1;
	const Collection = requireCollection();
	const { logger } = requireUtils();
	const FsAdapter = requireFs();
	const MigrationEngine = requireMigrations();
	const IndexEngine = requireIndexes();
	const { parseSchema, inferSchema } = requireValidator();
	const { sweep } = requireTtl();
	const OpenAIEmbeddingAdapter = requireOpenai$1();
	const OllamaEmbeddingAdapter = requireOllama$1();
	const OpenAIAIAdapter = requireOpenai();
	const AnthropicAIAdapter = requireAnthropic();
	const OllamaAIAdapter = requireOllama();
	const EncryptedAdapter = requireEncrypted();
	const Memory = requireMemory();
	const ChangeLog = requireChangelog();
	const { QueryCache, processLLMFilter, validateLLMFilter } = requireAsk();
	const EventBus = requireEvents();
	const QueryLog = requireQueryLog();
	const SessionStats = requireSessionStats();
	const PluginEngine = requirePlugins();
	const SkalexMCPServer = requireMcp();

	/**
	 * Skalex — an in-process document database with file-system persistence.
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
	   * @param {object}  [config.slowQueryLog]        - Slow query log options.
	   * @param {number}  [config.slowQueryLog.threshold] - Duration threshold in ms. Default: 100.
	   * @param {number}  [config.slowQueryLog.maxEntries] - Max entries to keep. Default: 500.
	   */
	  constructor({ path = "./.db", format = "gz", debug = false, adapter, ai, encrypt, slowQueryLog, plugins } = {}) {
	    this.dataDirectory = path;
	    this.dataFormat = format;
	    this.debug = debug;

	    let fs = adapter || new FsAdapter({ dir: path, format });
	    if (encrypt) fs = new EncryptedAdapter(fs, encrypt.key);
	    this.fs = fs;

	    this.collections = {};
	    this._collectionInstances = {};
	    this._migrations = new MigrationEngine();
	    this._autoConnectPromise = null;
	    this.isConnected = false;

	    this._aiConfig = ai || null;
	    this._encryptConfig = encrypt || null;
	    this._embeddingAdapter = ai ? this._createEmbeddingAdapter(ai) : null;
	    this._aiAdapter = ai ? this._createAIAdapter(ai) : null;
	    this._changeLog = new ChangeLog(this);
	    this._queryCache = new QueryCache();
	    this._eventBus = new EventBus();
	    this._queryLog = slowQueryLog ? new QueryLog(slowQueryLog) : null;
	    this._sessionStats = new SessionStats();
	    this._plugins = new PluginEngine();
	    // Pre-register any plugins passed to the constructor
	    if (Array.isArray(plugins)) {
	      for (const p of plugins) this._plugins.register(p);
	    }
	  }

	  // ─── Connection ──────────────────────────────────────────────────────────

	  /**
	   * Connect to the database: load data, run pending migrations, sweep TTL docs.
	   * @returns {Promise<void>}
	   */
	  async connect() {
	    try {
	      await this.loadData();

	      // Restore persisted query cache
	      const meta = this._getMeta();
	      if (meta.queryCache) this._queryCache.fromJSON(meta.queryCache);

	      // Run pending migrations
	      if (this._migrations._migrations.length > 0) {
	        const applied = meta.appliedVersions || [];
	        const newApplied = await this._migrations.run(
	          (version) => this.useCollection(`_migration_${version}`),
	          applied
	        );
	        this._saveMeta({ appliedVersions: newApplied });
	      }

	      // Sweep expired TTL documents
	      for (const name in this.collections) {
	        const col = this.collections[name];
	        const removed = sweep(col.data, col.index, col.fieldIndex ? doc => col.fieldIndex.remove(doc) : null);
	        if (removed > 0) this._log(`TTL sweep: removed ${removed} expired docs from "${name}"`);
	      }

	      this.isConnected = true;
	      this._log("> - Connected to the database (√)");
	    } catch (error) {
	      logger(`Error connecting to the database: ${error}`, "error");
	      throw error;
	    }
	  }

	  /**
	   * Disconnect: flush all unsaved data, clear in-memory state.
	   * @returns {Promise<void>}
	   */
	  async disconnect() {
	    try {
	      await this.saveData();
	      this.collections = {};
	      this._collectionInstances = {};
	      this._autoConnectPromise = null;
	      this.isConnected = false;
	      this._log("> - Disconnected from the database (√)");
	    } catch (error) {
	      logger(`Error disconnecting from the database: ${error}`, "error");
	      throw error;
	    }
	  }

	  /**
	   * Ensure connect() has been called before proceeding.
	   * Triggers auto-connect on the first operation if not already connected.
	   * @returns {Promise<void>}
	   */
	  async _ensureConnected() {
	    if (this.isConnected) return;
	    if (!this._autoConnectPromise) {
	      this._autoConnectPromise = this.connect();
	    }
	    return this._autoConnectPromise;
	  }

	  // ─── Collections ─────────────────────────────────────────────────────────

	  /**
	   * Get (or lazily create) a Collection instance by name.
	   * @param {string} collectionName
	   * @returns {Collection}
	   */
	  useCollection(collectionName) {
	    if (this._collectionInstances[collectionName]) {
	      return this._collectionInstances[collectionName];
	    }
	    if (!this.collections[collectionName]) {
	      this._createCollectionStore(collectionName);
	    }
	    const instance = new Collection(this.collections[collectionName], this);
	    this._collectionInstances[collectionName] = instance;
	    return instance;
	  }

	  /**
	   * Define a collection with optional schema and secondary indexes.
	   * Must be called before connect() so schema is available when loading data.
	   * @param {string} collectionName
	   * @param {{ schema?: object, indexes?: string[] }} [options]
	   * @returns {Collection}
	   */
	  createCollection(collectionName, options = {}) {
	    this._createCollectionStore(collectionName, options);
	    const instance = new Collection(this.collections[collectionName], this);
	    this._collectionInstances[collectionName] = instance;
	    return instance;
	  }

	  _createCollectionStore(collectionName, { schema, indexes = [], changelog = false } = {}) {
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

	    this.collections[collectionName] = {
	      collectionName,
	      data: [],
	      index: new Map(),
	      isSaving: false,
	      schema: parsedSchema,
	      fieldIndex,
	      changelog,
	    };
	  }

	  // ─── Persistence ─────────────────────────────────────────────────────────

	  /**
	   * Load all collections from the storage adapter.
	   * @returns {Promise<void>}
	   */
	  async loadData() {
	    try {
	      const names = await this.fs.list();

	      await Promise.all(names.map(async (name) => {
	        try {
	          const raw = await this.fs.read(name);
	          if (!raw) return;

	          const parsed = JSON.parse(raw);
	          const { collectionName, data } = parsed;
	          if (!collectionName) return;

	          // Preserve schema/index config from createCollection, if any
	          const existing = this.collections[collectionName];
	          const parsedSchema = existing ? existing.schema : null;
	          let fieldIndex = existing ? existing.fieldIndex : null;

	          const idIndex = this.buildIndex(data, "_id");
	          if (fieldIndex) fieldIndex.buildFromData(data);

	          this.collections[collectionName] = {
	            collectionName,
	            data,
	            index: idIndex,
	            isSaving: false,
	            schema: parsedSchema,
	            fieldIndex,
	          };
	        } catch (error) {
	          if (error.code !== "ENOENT") {
	            logger(`WARNING: Could not load collection "${name}": ${error.message}. Collection will be empty.`, "error");
	          }
	        }
	      }));
	    } catch (error) {
	      if (error.code !== "ENOENT") {
	        logger(`Error loading data: ${error}`, "error");
	        throw error;
	      }
	    }
	  }

	  /**
	   * Persist one or all collections via the storage adapter.
	   * @param {string} [collectionName] - If omitted, saves all collections.
	   * @returns {Promise<void>}
	   */
	  async saveData(collectionName) {
	    const saveOne = async (name) => {
	      const col = this.collections[name];
	      if (!col || col.isSaving) return;
	      col.isSaving = true;
	      try {
	        await this.fs.write(name, JSON.stringify({ collectionName: name, data: col.data }));
	      } catch (error) {
	        logger(`Error saving "${name}": ${error.message}`, "error");
	        throw error;
	      } finally {
	        col.isSaving = false;
	      }
	    };

	    if (collectionName) {
	      await saveOne(collectionName);
	    } else {
	      await Promise.all(Object.keys(this.collections).map(saveOne));
	    }
	  }

	  /**
	   * Build a Map index from an array of documents.
	   * @param {object[]} data
	   * @param {string} keyField
	   * @returns {Map}
	   */
	  buildIndex(data, keyField) {
	    const index = new Map();
	    for (const item of data) index.set(item[keyField], item);
	    return index;
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
	    const meta = this._getMeta();
	    return this._migrations.status(meta.appliedVersions || []);
	  }

	  // ─── Namespace ───────────────────────────────────────────────────────────

	  /**
	   * Create a scoped Skalex instance that stores data under a sub-directory.
	   * @param {string} id
	   * @returns {Skalex}
	   */
	  namespace(id) {
	    return new Skalex({
	      path: `${this.dataDirectory}/${id}`,
	      format: this.dataFormat,
	      debug: this.debug,
	      ai: this._aiConfig || undefined,
	      encrypt: this._encryptConfig || undefined,
	      slowQueryLog: this._queryLog ? { threshold: this._queryLog._threshold, maxEntries: this._queryLog._maxEntries } : undefined,
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

	  // ─── Transaction ─────────────────────────────────────────────────────────

	  /**
	   * Run a callback inside a transaction.
	   * All writes are buffered; if the callback throws, all changes are rolled back.
	   * @param {(db: Skalex) => Promise<any>} fn
	   * @returns {Promise<any>} The return value of fn.
	   */
	  async transaction(fn) {
	    // Deep-copy snapshot before transaction
	    const snapshot = {};
	    for (const name in this.collections) {
	      snapshot[name] = {
	        data: JSON.parse(JSON.stringify(this.collections[name].data)),
	        index: new Map(this.collections[name].index),
	      };
	    }

	    try {
	      const result = await fn(this);
	      await this.saveData();
	      return result;
	    } catch (error) {
	      // Rollback
	      for (const name in snapshot) {
	        if (!this.collections[name]) continue;
	        this.collections[name].data = snapshot[name].data;
	        this.collections[name].index = snapshot[name].index;
	        if (this.collections[name].fieldIndex) {
	          this.collections[name].fieldIndex.buildFromData(snapshot[name].data);
	        }
	      }
	      throw error;
	    }
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
	      this.useCollection(name);
	      if (reset) {
	        this.collections[name].data = [];
	        this.collections[name].index = new Map();
	        if (this.collections[name].fieldIndex) {
	          this.collections[name].fieldIndex.buildFromData([]);
	        }
	        // Evict cached instance so it sees the reset store
	        delete this._collectionInstances[name];
	      }
	      await this.useCollection(name).insertMany(docs);
	    }
	    await this.saveData();
	  }

	  // ─── Dump ────────────────────────────────────────────────────────────────

	  /**
	   * Return a snapshot of all collection data.
	   * @returns {object} Map of collectionName → docs[].
	   */
	  dump() {
	    const result = {};
	    for (const name in this.collections) {
	      result[name] = [...this.collections[name].data];
	    }
	    return result;
	  }

	  // ─── Inspect ─────────────────────────────────────────────────────────────

	  /**
	   * Return metadata about one or all collections.
	   * @param {string} [collectionName]
	   * @returns {object|null}
	   */
	  inspect(collectionName) {
	    if (collectionName) {
	      const col = this.collections[collectionName];
	      if (!col) return null;
	      return {
	        name: collectionName,
	        count: col.data.length,
	        schema: col.schema ? Object.fromEntries(col.schema.fields) : null,
	        indexes: col.fieldIndex ? [...col.fieldIndex.indexedFields] : [],
	      };
	    }
	    const result = {};
	    for (const name in this.collections) {
	      result[name] = this.inspect(name);
	    }
	    return result;
	  }

	  // ─── Import ──────────────────────────────────────────────────────────────

	  /**
	   * Import documents from a JSON or CSV file into a collection.
	   * The collection name is derived from the file name (without extension).
	   * @param {string} filePath - Absolute or relative path to the file.
	   * @param {"json"|"csv"} [format="json"]
	   * @returns {Promise<{ docs: object[] }>}
	   */
	  async import(filePath, format = "json") {
	    const content = await this.fs.readRaw(filePath);
	    let docs;

	    if (format === "json") {
	      docs = JSON.parse(content);
	    } else {
	      const lines = content.trim().split("\n");
	      const headers = lines[0].split(",");
	      docs = lines.slice(1).map(line => {
	        const values = line.split(",");
	        const doc = {};
	        headers.forEach((h, i) => { doc[h.trim()] = values[i] ? values[i].trim() : ""; });
	        return doc;
	      });
	    }

	    const name = filePath.split("/").pop().replace(/\.[^.]+$/, "");
	    const col = this.useCollection(name);
	    return col.insertMany(Array.isArray(docs) ? docs : [docs], { save: true });
	  }

	  // ─── Embedding ───────────────────────────────────────────────────────────

	  /**
	   * Embed a text string using the configured embedding adapter.
	   * @param {string} text
	   * @returns {Promise<number[]>}
	   */
	  async embed(text) {
	    if (!this._embeddingAdapter) {
	      throw new Error(
	        "db.embed() requires an AI adapter. Pass { ai: { provider, apiKey } } to the Skalex constructor."
	      );
	    }
	    return this._embeddingAdapter.embed(text);
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
	  async ask(collectionName, nlQuery, { limit = 20 } = {}) {
	    if (!this._aiAdapter) {
	      throw new Error(
	        'db.ask() requires a language model adapter. Configure { ai: { provider, model: "..." } }.'
	      );
	    }

	    const col = this.useCollection(collectionName);
	    const store = this.collections[collectionName];

	    // Build a schema descriptor for the LLM
	    let schema = null;
	    if (store && store.schema) {
	      schema = Object.fromEntries(
	        [...store.schema.fields.entries()].map(([k, v]) => [k, v.type])
	      );
	    } else if (store && store.data.length > 0) {
	      schema = inferSchema(store.data[0]);
	    }

	    // Cache lookup
	    let filter = this._queryCache.get(collectionName, schema, nlQuery);
	    if (!filter) {
	      filter = await this._aiAdapter.generate(schema, nlQuery);
	      const warnings = validateLLMFilter(filter, schema);
	      if (warnings.length) warnings.forEach(w => this._log(`[ask] ${w}`));
	      this._queryCache.set(collectionName, schema, nlQuery, filter);
	      this._saveMeta({ queryCache: this._queryCache.toJSON() });
	    }

	    return col.find(processLLMFilter(filter), { limit });
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
	    const store = this.collections[collectionName];
	    if (!store) return null;
	    if (store.schema) {
	      return Object.fromEntries(
	        [...store.schema.fields.entries()].map(([k, v]) => [k, v.type])
	      );
	    }
	    if (store.data.length > 0) return inferSchema(store.data[0]);
	    return null;
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
	  async restore(collectionName, timestamp, opts = {}) {
	    return this._changeLog.restore(collectionName, timestamp, opts);
	  }

	  // ─── Stats ────────────────────────────────────────────────────────────────

	  /**
	   * Return size statistics for one or all collections.
	   * @param {string} [collectionName]
	   * @returns {object|object[]}
	   */
	  stats(collectionName) {
	    const calc = (name) => {
	      const col = this.collections[name];
	      if (!col) return null;
	      const count = col.data.length;
	      let estimatedSize = 0;
	      for (const doc of col.data) {
	        try { estimatedSize += JSON.stringify(doc).length; } catch (_) {}
	      }
	      return {
	        collection:    name,
	        count,
	        estimatedSize,
	        avgDocSize:    count > 0 ? Math.round(estimatedSize / count) : 0,
	      };
	    };

	    if (collectionName) return calc(collectionName);
	    return Object.keys(this.collections).map(calc);
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

	  // ─── MCP Server ───────────────────────────────────────────────────────────

	  /**
	   * Create a Skalex MCP server that exposes this database as MCP tools.
	   *
	   * @param {object} [opts]
	   * @param {"stdio"|"http"} [opts.transport]  - Transport type. Default: "stdio".
	   * @param {number}  [opts.port]              - HTTP port. Default: 3000.
	   * @param {string}  [opts.host]              - HTTP host. Default: "127.0.0.1".
	   * @param {object}  [opts.scopes]            - Access control map. Default: { "*": ["read", "write"] }.
	   * @returns {SkalexMCPServer}
	   */
	  mcp(opts = {}) {
	    return new SkalexMCPServer(this, opts);
	  }

	  // ─── Private ─────────────────────────────────────────────────────────────

	  _getMeta() {
	    const metaCol = this.collections["_meta"];
	    if (!metaCol) return {};
	    return metaCol.index.get("migrations") || {};
	  }

	  _saveMeta(data) {
	    if (!this.collections["_meta"]) {
	      this._createCollectionStore("_meta");
	    }
	    const col = this.collections["_meta"];
	    const existing = col.index.get("migrations");
	    if (existing) {
	      Object.assign(existing, data);
	    } else {
	      const doc = { _id: "migrations", ...data };
	      col.data.push(doc);
	      col.index.set("migrations", doc);
	    }
	  }

	  _createEmbeddingAdapter({ provider, apiKey, embedModel, model, host }) {
	    const resolvedModel = embedModel || model;
	    switch (provider) {
	      case "openai":
	        return new OpenAIEmbeddingAdapter({ apiKey, model: resolvedModel });
	      case "ollama":
	        return new OllamaEmbeddingAdapter({ model: resolvedModel, host });
	      default:
	        throw new Error(
	          `Unknown AI provider: "${provider}". Supported: "openai", "ollama".`
	        );
	    }
	  }

	  _createAIAdapter({ provider, apiKey, model, host }) {
	    if (!model) return null; // LLM adapter is optional
	    switch (provider) {
	      case "openai":
	        return new OpenAIAIAdapter({ apiKey, model });
	      case "anthropic":
	        return new AnthropicAIAdapter({ apiKey, model });
	      case "ollama":
	        return new OllamaAIAdapter({ model, host });
	      default:
	        return null; // unknown provider — skip silently (embedding may still work)
	    }
	  }

	  _log(msg) {
	    if (this.debug) logger(msg);
	  }
	}

	src = Skalex;
	return src;
}

var srcExports = requireSrc();
var index = /*@__PURE__*/getDefaultExportFromCjs(srcExports);

module.exports = index;
//# sourceMappingURL=skalex.cjs.js.map
