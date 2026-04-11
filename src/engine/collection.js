import { generateUniqueId } from "./utils.js";
import { matchesFilter, presortFilter } from "./query.js";
import { validateDoc, stripInvalidFields } from "./validator.js";
import { computeExpiry } from "./ttl.js";
import { cosineSimilarity, stripVector } from "./vector.js";
import { count as aggCount, sum as aggSum, avg as aggAvg, groupBy as aggGroupBy } from "../features/aggregation.js";
import { ValidationError, UniqueConstraintError, PersistenceError, QueryError, AdapterError } from "./errors.js";
import MutationPipeline from "./pipeline.js";
import { Ops, Hooks } from "./constants.js";

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
 * Collection represents a collection of documents in the database.
 */
class Collection {
  /**
   * @param {object} collectionData - Internal store object managed by Skalex.
   * @param {Skalex} database - The parent Skalex instance.
   */
  constructor(collectionData, database) {
    this.name = collectionData.collectionName;

    /**
     * @type {CollectionContext} Narrow dependency surface for Collection operations.
     * Shared across all collections of a Skalex instance - the ctx uses lazy
     * getters that defer to the database, so a single allocation suffices.
     */
    this._ctx = database._collectionContext;

    this._store = collectionData;
    this._pipeline = new MutationPipeline(this);

    /** @type {number|null} If created inside a transaction, the tx ID. */
    this._createdInTxId = database._txManager.context?.id ?? null;

    /** @type {number|null} Set by the tx proxy when obtained via tx.useCollection(). */
    this._activeTxId = null;
  }

  get _data() { return this._store.data; }
  set _data(val) { this._store.data = val; }
  get _index() { return this._store.index; }

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
  async _insertCore(items, { ttl, embed, session, save }) {
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
          if (this._index.has(newItem._id) || batchIds.has(newItem._id)) {
            throw new UniqueConstraintError("ERR_SKALEX_UNIQUE_DUPLICATE_ID", `Duplicate _id "${newItem._id}" in collection "${this.name}"`, { id: newItem._id, collection: this.name });
          }
          batchIds.add(newItem._id);
          newItems.push(newItem);
        }

        assertTxAlive(); // guard before first in-memory state change
        if (this._fieldIndex) this._fieldIndex.assertUniqueBatch(newItems);
        for (const newItem of newItems) this._addToIndex(newItem);
        this._data.push(...newItems);
        for (const newItem of newItems) this._index.set(newItem._id, newItem);
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
  async _updateCore(oldDocs, filter, update, { save, session }) {
    return this._pipeline.execute({
      op: Ops.UPDATE,
      beforeHook: Hooks.BEFORE_UPDATE,
      afterHook: Hooks.AFTER_UPDATE,
      hookPayload: { collection: this.name, filter, update },
      save,
      session,
      afterHookPayload: (docs) => ({ collection: this.name, filter, update, result: docs.length === 1 ? docs[0] : docs }),
      mutate: async (assertTxAlive) => {
        const prevDocs = this._changelogEnabled ? oldDocs.map(doc => structuredClone(doc)) : oldDocs.map(() => null);
        const nextDocs = oldDocs.map(doc => this._prepareUpdatedDoc(doc, update));

        this._assertUniqueCandidates(oldDocs, nextDocs);

        assertTxAlive(); // guard before first in-memory state change
        // Pre-compute positions in one pass to avoid O(n) indexOf per doc.
        const targets = new Set(oldDocs);
        const positions = new Map();
        for (let i = 0; i < this._data.length; i++) {
          if (targets.has(this._data[i])) positions.set(this._data[i], i);
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
  _prepareUpdatedDoc(currentDoc, update) {
    const prev = structuredClone(currentDoc);
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
    const idx = positions ? positions.get(oldDoc) : this._data.indexOf(oldDoc);
    if (idx === undefined || idx === -1) {
      throw new PersistenceError("ERR_SKALEX_PERSISTENCE_DOC_MISSING", `Document "${oldDoc._id}" no longer exists in collection "${this.name}"`, { id: oldDoc._id, collection: this.name });
    }
    this._data[idx] = newDoc;
    this._index.set(newDoc._id, newDoc);
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
    await this._ctx.ensureConnected();
    const { save, ...rest } = options;

    const results = [];
    for (const doc of docs) {
      results.push(await this.upsert({ [matchKey]: doc[matchKey] }, doc, { ...rest, save: false }));
    }

    await this._saveIfNeeded(save);
    return results;
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
      afterHook: null,
      hookPayload: null,
      save,
      session,
      mutate: async (assertTxAlive) => {
        assertTxAlive();
        delete item._deletedAt;
        item.updatedAt = new Date();
        this._index.set(item._id, item);
        return { docs: [item] };
      },
    });
    return stripVector(docs[0]);
  }

  // ─── Watch ───────────────────────────────────────────────────────────────

  /**
   * Watch for mutation events on this collection.
   *
   * Callback form  -  returns an unsubscribe function:
   *   const unsub = col.watch({ status: "active" }, event => console.log(event));
   *   unsub(); // stop watching
   *
   * AsyncIterator form  -  no callback:
   *   for await (const event of col.watch({ status: "active" })) { ... }
   *
   * Event shape: { op: "insert"|"update"|"delete"|"restore", collection, doc, prev? }
   *
   * @param {object|Function} [filter]
   * @param {Function} [callback]
   * @returns {(() => void)|AsyncIterableIterator}
   */
  watch(filter, callback) {
    // watch(callback) shorthand  -  no filter
    if (typeof filter === "function") { callback = filter; filter = null; }

    if (callback) {
      // Callback-based API  -  returns unsub fn
      return this._ctx.eventBus.on(this.name, event => {
        if (!filter || matchesFilter(event.doc, filter)) callback(event);
      });
    }

    // AsyncIterator API
    return this._watchIterator(filter);
  }

  _watchIterator(filter) {
    const queue = [];
    let resolve = null;
    let done = false;

    const unsub = this._ctx.eventBus.on(this.name, event => {
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
    return aggCount(this._findAllRaw(filter));
  }

  /**
   * Sum a numeric field across matching documents.
   * @param {string} field
   * @param {object} [filter={}]
   * @returns {Promise<number>}
   */
  async sum(field, filter = {}) {
    await this._ctx.ensureConnected();
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
    await this._ctx.ensureConnected();
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
    await this._ctx.ensureConnected();
    return aggGroupBy(this._findAllRaw(filter), field);
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
    const sortedFilter = presortFilter(
      filter,
      this._fieldIndex ? this._fieldIndex.indexedFields : new Set()
    );

    let results = [];

    for (const item of candidates) {
      if (!this._isVisible(item, includeDeleted)) continue;
      if (!matchesFilter(item, sortedFilter)) continue;
      const newItem = this._projectDoc(item, select);
      if (populate) await this._populateDoc(newItem, item, populate);
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

    let extra;
    if (limit) {
      const totalDocs = results.length;
      const totalPages = Math.ceil(totalDocs / limit);
      const startIndex = (page - 1) * limit;
      results = results.slice(startIndex, startIndex + limit);
      extra = { page, totalDocs, totalPages };
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
    const queryVector = await this._ctx.embed(query);

    const candidates = filter ? this._findAllRaw(filter) : this._data;

    const scored = [];
    for (const doc of candidates) {
      if (!doc._vector) continue;
      const score = cosineSimilarity(queryVector, doc._vector);
      if (score >= minScore) scored.push({ doc, score });
    }

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, limit);

    this._ctx.queryLog?.record({ collection: this.name, op: "search", query, duration: Date.now() - _t0, resultCount: top.length });
    this._ctx.sessionStats.recordRead(session);

    const docs = top.map(r => stripVector(r.doc));
    const scores = top.map(r => r.score);
    await this._ctx.plugins.run(Hooks.AFTER_SEARCH, { collection: this.name, query, options: { filter, limit, minScore }, docs, scores });

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
    await this._ctx.ensureConnected();
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
  async _deleteCore(mode, items, filter, { save, session }) {
    return this._pipeline.execute({
      op: Ops.DELETE,
      beforeHook: Hooks.BEFORE_DELETE,
      afterHook: Hooks.AFTER_DELETE,
      hookPayload: { collection: this.name, filter },
      save,
      session,
      afterHookPayload: (docs) => ({ collection: this.name, filter, result: docs.length === 1 ? docs[0] : docs }),
      mutate: async (assertTxAlive) => {
        assertTxAlive(); // guard before first in-memory state change
        if (mode === "soft") {
          const now = new Date();
          for (const item of items) {
            item._deletedAt = now;
            item.updatedAt = now;
            this._index.set(item._id, item);
          }
          return { docs: items };
        }

        if (mode === "hard") {
          const idx = this._findIndex(filter);
          if (idx === -1) return { docs: [] };
          const deletedItem = this._data.splice(idx, 1)[0];
          this._index.delete(deletedItem._id);
          this._removeFromIndex(deletedItem);
          return { docs: [deletedItem] };
        }

        // hardMany
        const deletedItems = [];
        const remainingItems = [];
        for (const item of this._data) {
          if (matchesFilter(item, filter)) {
            deletedItems.push(item);
            this._index.delete(item._id);
            this._removeFromIndex(item);
          } else {
            remainingItems.push(item);
          }
        }
        this._data = remainingItems;
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
  async export(filter = {}, options = {}) {
    const { dir, name, format = "json" } = options;

    try {
      const filteredData = this._data.filter(item => matchesFilter(item, filter));

      if (filteredData.length === 0) {
        throw new QueryError("ERR_SKALEX_QUERY_EXPORT_EMPTY", `export(): no documents matched the filter in "${this.name}"`, { collection: this.name });
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

      if (typeof this._ctx.fs.writeRaw !== "function") {
        throw new AdapterError(
          "ERR_SKALEX_ADAPTER_NO_RAW_WRITE",
          `export() requires a file-system adapter (FsAdapter). The current adapter does not support raw file writes.`
        );
      }

      const exportDir = dir || `${this._ctx.dataDirectory}/exports`;
      const fileName = `${name || this.name}.${format}`;
      const filePath = this._ctx.fs.join(exportDir, fileName);

      this._ctx.fs.ensureDir(exportDir);
      await this._ctx.fs.writeRaw(filePath, content);
    } catch (error) {
      this._ctx.logger(`Error exporting "${this.name}": ${error.message}`, "error");
      throw error;
    }
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
    if (!max || this._data.length <= max) return [];
    const evictCount = this._data.length - max;
    const toEvict = this._data.slice(0, evictCount);

    // Per-doc removal state:
    //   0 = untouched
    //   1 = removed from id-index
    //   2 = removed from id-index AND field-index
    const states = new Array(toEvict.length).fill(0);
    try {
      for (let i = 0; i < toEvict.length; i++) {
        const doc = toEvict[i];
        this._index.delete(doc._id);
        states[i] = 1;
        this._removeFromIndex(doc);
        states[i] = 2;
      }
      this._data.splice(0, evictCount);
      return toEvict;
    } catch (err) {
      // Restore in reverse order. For each doc, undo exactly the steps that
      // were committed. This leaves `_data` + both indexes consistent.
      for (let i = toEvict.length - 1; i >= 0; i--) {
        const doc = toEvict[i];
        if (states[i] === 0) continue;
        if (states[i] === 2) {
          try { this._addToIndex(doc); } catch { /* best-effort */ }
        }
        // states 1 and 2 both require id-index restore
        this._index.set(doc._id, doc);
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

  _findRaw(filter, { includeDeleted = false } = {}) {
    if (typeof filter === "function") {
      for (const doc of this._data) {
        if (!this._isVisible(doc, includeDeleted)) continue;
        if (filter(doc)) return doc;
      }
      return null;
    }
    // Null, undefined, or empty filter: return the first visible doc.
    // Matches matchesFilter's "everything matches" semantics for nullish
    // and empty-object filters, and keeps `findOne()` / `findOne(null)`
    // working (they used to crash on `filter._id`).
    if (filter == null) {
      for (const doc of this._data) {
        if (this._isVisible(doc, includeDeleted)) return doc;
      }
      return null;
    }
    if (filter._id) {
      const item = this._index.get(filter._id) || null;
      if (!item) return null;
      if (!this._isVisible(item, includeDeleted)) return null;
      if (Object.keys(filter).length > 1) {
        return matchesFilter(item, filter) ? item : null;
      }
      return item;
    }

    // Try O(1) indexed field lookup first
    if (this._fieldIndex) {
      for (const key in filter) {
        if (key === "$or" || key === "$and" || key === "$not") continue;
        const val = filter[key];
        if (typeof val !== "object" || val === null) {
          const candidates = this._fieldIndex._lookupIterable(key, val);
          if (candidates !== null) {
            for (const doc of candidates) {
              if (!this._isVisible(doc, includeDeleted)) continue;
              if (matchesFilter(doc, filter)) return doc;
            }
            return null;
          }
        }
      }
    }

    for (const doc of this._data) {
      if (!this._isVisible(doc, includeDeleted)) continue;
      if (matchesFilter(doc, filter)) return doc;
    }
    return null;
  }

  _findAllRaw(filter, { includeDeleted = false } = {}) {
    if (filter && typeof filter !== "function" && filter._id) {
      const item = this._index.get(filter._id);
      if (!item) return [];
      if (!this._isVisible(item, includeDeleted)) return [];
      return matchesFilter(item, filter) ? [item] : [];
    }
    const results = [];
    for (const doc of this._getCandidates(filter)) {
      if (!this._isVisible(doc, includeDeleted)) continue;
      if (matchesFilter(doc, filter)) results.push(doc);
    }
    return results;
  }

  _getCandidates(filter) {
    if (!this._fieldIndex) return this._data;

    // Try compound index first - matches more fields in one lookup
    if (this._fieldIndex._compoundIndexes.size > 0) {
      const eqFields = {};
      for (const key in filter) {
        if (key === "$or" || key === "$and" || key === "$not") continue;
        const val = filter[key];
        if (typeof val !== "object" || val === null) eqFields[key] = val;
      }
      if (Object.keys(eqFields).length >= 2) {
        const candidates = this._fieldIndex.lookupCompound(eqFields);
        if (candidates !== null) return candidates;
      }
    }

    // Fall back to single-field index
    for (const key in filter) {
      if (key === "$or" || key === "$and" || key === "$not") continue;
      const val = filter[key];
      if (typeof val !== "object" || val === null) {
        const candidates = this._fieldIndex._lookupIterable(key, val);
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
  async _buildDoc(item, { ttl, embed } = {}) {
    const newItem = {
      ...item,
      _id: item._id ?? (this._ctx.idGenerator ?? generateUniqueId)(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const resolvedTtl = ttl ?? this._defaultTtl;
    if (resolvedTtl) newItem._expiresAt = computeExpiry(resolvedTtl);

    const resolvedEmbed = embed ?? this._defaultEmbed;
    if (resolvedEmbed) {
      const text = typeof resolvedEmbed === "function" ? resolvedEmbed(newItem) : newItem[resolvedEmbed];
      newItem._vector = await this._ctx.embed(String(text));
    }

    if (this._versioning) newItem._version = 1;

    return newItem;
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

export default Collection;
