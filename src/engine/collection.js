import { matchesFilter, presortFilter, compileRegexFilter } from "./query.js";
import { validateDoc, stripInvalidFields } from "./validator.js";
import { stripVector } from "./vector.js";
import { count as aggCount, sum as aggSum, avg as aggAvg, groupBy as aggGroupBy } from "../features/aggregation.js";
import { SkalexError, ValidationError, UniqueConstraintError, PersistenceError, QueryError } from "./errors.js";
import MutationPipeline from "./pipeline.js";
import { Ops, Hooks } from "./constants.js";
import { buildDoc } from "./document-builder.js";
import { findRaw, findAllRaw, getCandidates, findIndex } from "./query-planner.js";
import { vectorSearch, similarByVector } from "./vector-search.js";
import { exportData } from "./exporter.js";
import InMemoryDataStore from "./datastore.js";

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

  // --- Insert --------------------------------------------------------------

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
   * Shared per-document insert preamble for `_insertCore` and `upsertMany`.
   *
   * Validates the body, runs the `BEFORE_INSERT` hook, builds the document, and
   * enforces `_id` uniqueness within the in-flight batch (`batchIds`).
   * The caller checks the live store immediately before committing.
   * Returns the prepared document WITHOUT indexing or
   * pushing it: the caller owns the unique-field batch assertion, index
   * insertion, and store push. This split is deliberate - `_insertCore` asserts
   * uniqueness and indexes the whole batch together (so intra-batch unique
   * collisions surface as "duplicate within batch" before any document lands),
   * while `upsertMany` interleaves inserts with updates and commits each one as
   * it goes. Keeping commit out of this helper preserves both timings.
   * @param {object} body - raw document body to validate and build
   * @param {{ ttl?: number|string, embed?: string|Function, batchIds: Set<string>|null }} opts
   * @returns {Promise<object>} the prepared document (not yet indexed or pushed)
   */
  async _prepareInsertInBatch(body, { ttl, embed, batchIds }) {
    const validated = this._applyValidation(body);
    await this._ctx.plugins.run(Hooks.BEFORE_INSERT, { collection: this.name, doc: validated });
    const newDoc = await this._buildDoc(validated, { ttl, embed });
    if (batchIds) {
      this._assertInsertIdAvailable(newDoc._id, batchIds);
      batchIds.add(newDoc._id);
    }
    return newDoc;
  }

  /**
   * Check batch IDs during preparation and live IDs at synchronous commit.
   * Preparation can await hooks or embedding, so a live-store check there
   * cannot protect the later commit.
   * @param {*} id
   * @param {Set|InMemoryDataStore} [ids]
   */
  _assertInsertIdAvailable(id, ids = this._ds) {
    if (ids.has(id)) {
      throw new UniqueConstraintError("ERR_SKALEX_UNIQUE_DUPLICATE_ID", `Duplicate _id "${id}" in collection "${this.name}"`, { id, collection: this.name });
    }
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
        const batchIds = items.length > 1 ? new Set() : null;
        for (const item of items) {
          newItems.push(await this._prepareInsertInBatch(item, { ttl, embed, batchIds }));
        }

        assertTxAlive(); // guard before first in-memory state change
        for (const item of newItems) this._assertInsertIdAvailable(item._id);
        const evicted = this._commitInsertedDocs(newItems, true, true);
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

  // --- Update --------------------------------------------------------------

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
   * Shared per-document update preamble for `_updateCore` and `upsertMany`.
   *
   * Snapshots the previous document when the changelog needs it and applies the
   * update descriptor via `_prepareUpdatedDoc`. Returns `{ next, prev }` WITHOUT
   * touching live state: the caller owns the unique-candidate assertion and the
   * store commit, which differ by path - `_updateCore` asserts once across the
   * batch and replaces indexes before committing through a positions map, while `upsertMany`
   * asserts and commits per document via `_commitUpdatedDoc`. `_prepareUpdatedDoc`
   * does not mutate `oldDoc`, so snapshotting `prev` here is order-safe.
   * @param {object} oldDoc
   * @param {object} update - the update descriptor to apply
   * @returns {{ next: object, prev: object|null }}
   */
  _prepareUpdateInBatch(oldDoc, update) {
    const needsPrev = this._changelogEnabled || this._onSchemaError === "strip";
    const prev = this._changelogEnabled ? structuredClone(oldDoc) : null;
    const next = this._prepareUpdatedDoc(oldDoc, update, { needsPrev });
    return { next, prev };
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
        const nextDocs = [];
        const prevDocs = [];
        for (const oldDoc of oldDocs) {
          const { next, prev } = this._prepareUpdateInBatch(oldDoc, update);
          nextDocs.push(next);
          prevDocs.push(prev);
        }

        assertTxAlive(); // guard before first in-memory state change
        this._commitUpdatedDocs(oldDocs, nextDocs);

        return { docs: nextDocs, prevDocs };
      },
    });
  }

  /**
   * Apply an update descriptor to a document in place.
   * Supports $inc, $push, and direct assignment. Increments _version when versioning is on.
   * Skips _id, createdAt, and updatedAt - these are system-managed. A user-provided
   * `updatedAt` value is silently discarded. The field is always set to the current
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

  /** Commit a prepared update batch with bounded failure recovery. */
  _commitUpdatedDocs(oldDocs, nextDocs) {
    if (oldDocs.length === 1) {
      this._commitUpdatedDoc(oldDocs[0], nextDocs[0]);
    } else {
      // Pre-compute positions in one pass to avoid O(n) indexOf per doc.
      const targets = new Set(oldDocs);
      const positions = new Map();
      for (let i = 0; i < this._ds.data.length; i++) {
        if (targets.has(this._ds.data[i])) positions.set(this._ds.data[i], i);
      }
      for (const doc of oldDocs) this._assertUpdatePosition(doc, positions.get(doc));
      try {
        this._fieldIndex?._replaceBatch(oldDocs, nextDocs);
        for (let i = 0; i < oldDocs.length; i++) {
          this._ds.replaceAt(positions.get(oldDocs[i]), nextDocs[i]);
        }
      } catch (error) {
        const previous = this._ds.data.slice();
        for (const doc of oldDocs) previous[positions.get(doc)] = doc;
        this._recoverCommit(error, previous);
      }
    }
  }

  /**
   * Replace a live document with a prepared document and update all indexes.
   * @param {object} oldDoc
   * @param {object} newDoc
   */
  _commitUpdatedDoc(oldDoc, newDoc) {
    const idx = this._ds.indexOf(oldDoc);
    this._assertUpdatePosition(oldDoc, idx);
    try {
      this._updateInIndex(oldDoc, newDoc);
      this._ds.replaceAt(idx, newDoc);
    } catch (error) {
      const previous = this._ds.data.slice();
      previous[idx] = oldDoc;
      this._recoverCommit(error, previous);
    }
  }

  /** Reject stale targets before any document or index in the batch changes. */
  _assertUpdatePosition(oldDoc, idx) {
    if (idx === undefined || idx === -1) {
      throw new PersistenceError("ERR_SKALEX_PERSISTENCE_DOC_MISSING", `Document "${oldDoc._id}" no longer exists in collection "${this.name}"`, { id: oldDoc._id, collection: this.name });
    }
  }

  // --- Upsert --------------------------------------------------------------

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
   * Completed items remain applied if a later item fails. Their normal pipeline
   * effects and a single save (honouring autoSave/save) finish before rejection.
   * An uncaught error inside transaction() triggers the enclosing rollback.
   * @param {object[]} docs
   * @param {string} matchKey
   * @param {{ save?: boolean, ttl?: number|string, embed?: string|Function, session?: string }} [options]
   * @returns {Promise<object[]>} Applied documents when every item succeeds.
   * @throws {ValidationError|UniqueConstraintError} Invalid arguments or item constraints.
   * @throws {SkalexError} ERR_SKALEX_MUTATION_FINALIZE if an item and finalization both fail.
   * @example
   * await products.upsertMany([{ sku: "A", qty: 2 }], "sku", { save: true });
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
    // Per-doc plugin hooks (beforeInsert/beforeUpdate inside the closure.
    // afterInsert/afterUpdate outside) preserve the contract consumers rely on.
    let failure;
    let finalizing = false;
    let result;
    try {
      result = await this._pipeline.executeBatch({
        op: Ops.UPDATE,
        save,
        session,
        mutateBatch: async (assertTxAlive) => {
          const outDocs = [];
          const prevDocs = [];
          const ops = [];
          let inserted = false;
          const batchIds = new Set();

          try {
            for (const raw of docs) {
              const filter = { [matchKey]: raw[matchKey] };
              const existing = this._findRaw(filter);

              if (existing) {
                // Update path. Shares the prepare preamble and commit primitive with
                // _updateCore. The per-doc hook and validating index commit
                // preserve upsertMany's interleaved semantics.
                await this._ctx.plugins.run(Hooks.BEFORE_UPDATE, {
                  collection: this.name,
                  filter,
                  update: raw,
                });
                const { next, prev } = this._prepareUpdateInBatch(existing, raw);

                assertTxAlive();
                this._commitUpdatedDoc(existing, next);

                outDocs.push(next);
                prevDocs.push(prev);
                ops.push(Ops.UPDATE);
              } else {
                // Insert path. Shares the prepare preamble with _insertCore. The
                // validating index insertion and push stay here so
                // upsertMany keeps committing each insert as it interleaves them
                // with updates (rather than the batch-at-once path _insertCore uses).
                const body = { ...resolveFilterToValues(filter), ...raw };
                const newDoc = await this._prepareInsertInBatch(body, { ttl, embed, batchIds });

                assertTxAlive();
                this._assertInsertIdAvailable(newDoc._id);
                this._commitInsertedDocs([newDoc]);
                inserted = true;

                outDocs.push(newDoc);
                prevDocs.push(null);
                ops.push(Ops.INSERT);
              }
            }
          } catch (error) {
            if (this._store._recoveryError) throw error;
            // Preserve completed items and finish their normal pipeline lifecycle.
            failure = { error };
          }

          // A timed-out transaction may have rolled back while a hook awaited.
          assertTxAlive();
          finalizing = outDocs.length > 0;

          // Apply FIFO capacity enforcement once after all inserts land.
          if (inserted) {
            let evicted = [];
            try { evicted = this._enforceCapAfterInsert(); }
            catch (error) {
              if (this._store._recoveryError) throw error;
              failure ??= { error };
            }
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
    } catch (error) {
      if (!failure || !finalizing) throw error;
      throw new SkalexError(
        "ERR_SKALEX_MUTATION_FINALIZE",
        "upsertMany() failed and its completed items could not be fully finalized.",
        { collection: this.name, mutationError: failure.error, finalizationError: error }
      );
    }

    if (failure) throw failure.error;
    return result.docs.map(stripVector);
  }

  // --- Soft-delete restore --------------------------------------------------

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
        const next = { ...item, updatedAt: new Date() };
        delete next._deletedAt;
        this._commitUpdatedDoc(item, next);
        return { docs: [next] };
      },
    });
    return stripVector(docs[0]);
  }

  // --- Watch ---------------------------------------------------------------

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

  // --- Aggregation ---------------------------------------------------------

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
   * Returns `{ [value]: docs[] }`. Pass clone: true to detach the result.
   * @param {string} field
   * @param {object} [filter={}]
   * @param {{ clone?: boolean }} [options]
   * @throws {QueryError} ERR_SKALEX_QUERY_CLONE if requested cloning fails.
   * @example
   * await collection.groupBy("role", {}, { clone: true });
   * @returns {Promise<Record<string, object[]>>}
   */
  async groupBy(field, filter = {}, { clone = false } = {}) {
    await this._ctx.ensureConnected();
    const result = aggGroupBy(this._findAllRaw(filter), field);
    return clone ? this._cloneReadResult(result) : result;
  }

  // --- Find -----------------------------------------------------------------

  /**
   * Find the first matching document (returns a shallow copy with projection).
   * @param {object} filter
   * @param {{ populate?: string[], select?: string[], includeDeleted?: boolean, clone?: boolean }} [options]
   * @returns {Promise<object|null>}
   * @throws {QueryError} ERR_SKALEX_QUERY_CLONE if requested cloning fails.
   */
  async findOne(filter, options = {}) {
    _assertFilter("findOne", filter);
    await this._ctx.ensureConnected();
    const { populate, select, includeDeleted = false, clone = false } = options;
    const item = this._findRaw(filter, { includeDeleted });
    if (!item) return null;

    const newItem = this._projectDoc(item, select);
    if (populate) await this._populateDoc(newItem, item, populate);
    return clone ? this._cloneReadResult(newItem) : newItem;
  }

  /**
   * Find all matching documents. Sort stored field values and paginate before
   * projecting or populating the returned documents.
   *
   * **Limit-only fast path:** when `limit` is set, `sort` is absent, and
   * `page` is 1 (default), scanning stops after `limit` matches. In this
   * mode `totalDocs` and `totalPages` are omitted from the result because
   * the total is unknown without a full scan. Callers that need totals
   * should pass an explicit `sort` or `page` to disable the fast path.
   *
   * @param {object} filter
   * @param {{ populate?: string[], select?: string[], sort?: object, page?: number, limit?: number, includeDeleted?: boolean, clone?: boolean }} [options]
   * @returns {Promise<{ docs: object[], page?: number, totalDocs?: number, totalPages?: number }>}
   * @throws {QueryError} ERR_SKALEX_QUERY_CLONE if requested cloning fails.
   */
  async find(filter, options = {}) {
    _assertFilter("find", filter);
    await this._ctx.ensureConnected();
    const _t0 = Date.now();
    const { populate, select, sort, page = 1, limit, session, includeDeleted = false, clone = false } = options;

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
      if (sort) results.push(item);
      else {
        const projected = this._projectDoc(item, select);
        if (populate) await this._populateDoc(projected, item, populate);
        results.push(projected);
      }
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

    // Sort and paginate stored values before projection or population hides keys.
    for (let i = 0; sort && i < results.length; i++) {
      const item = results[i];
      const projected = this._projectDoc(item, select);
      if (populate) await this._populateDoc(projected, item, populate);
      results[i] = projected;
    }

    this._ctx.queryLog?.record({ collection: this.name, op: "find", filter, duration: Date.now() - _t0, resultCount: results.length });
    this._ctx.sessionStats.recordRead(session);
    await this._ctx.plugins.run(Hooks.AFTER_FIND, { collection: this.name, filter, options, docs: results });
    if (clone) results = this._cloneReadResult(results);
    return extra ? { docs: results, ...extra } : { docs: results };
  }

  // --- Vector Search -------------------------------------------------------

  /**
   * Semantic similarity search  -  embed a query string and rank all documents
   * with a `_vector` field by cosine similarity.
   *
   * @param {string} query
   * @param {{ filter?: object, limit?: number, minScore?: number, clone?: boolean }} [options]
   * @returns {Promise<{ docs: object[], scores: number[] }>}
   * @throws {QueryError} ERR_SKALEX_QUERY_CLONE if requested cloning fails.
   */
  async search(query, { filter, limit = 10, minScore = 0, session, clone = false } = {}) {
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

    return clone ? this._cloneReadResult(result) : result;
  }

  /**
   * Find the nearest neighbours to an existing document by `_id`.
   *
   * @param {string} id
   * @param {{ limit?: number, minScore?: number, clone?: boolean }} [options]
   * @returns {Promise<{ docs: object[], scores: number[] }>}
   * @throws {QueryError} ERR_SKALEX_QUERY_CLONE if requested cloning fails.
   */
  async similar(id, { limit = 10, minScore = 0, clone = false } = {}) {
    await this._ctx.ensureConnected();
    const source = this._ds.getById(id);
    if (!source || !source._vector) return { docs: [], scores: [] };
    const result = similarByVector(source._vector, id, this._ds.data, { limit, minScore });
    return clone ? this._cloneReadResult(result) : result;
  }

  // --- Delete --------------------------------------------------------------

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
          const next = items.map(item => ({ ...item, _deletedAt: now, updatedAt: now }));
          this._commitUpdatedDocs(items, next);
          return { docs: next };
        }

        if (mode === "hard") {
          const idx = this._findIndex(filter);
          if (idx === -1) return { docs: [] };
          const deletedItem = this._ds.data[idx];
          this._commitDeletedDoc(deletedItem, idx);
          return { docs: [deletedItem] };
        }

        // hardMany
        const previous = this._ds.data;
        const deletedItems = [];
        const remainingItems = [];
        try {
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
        } catch (error) { this._recoverCommit(error, previous); }
        return { docs: deletedItems };
      },
    });
  }

  // --- Export --------------------------------------------------------------

  /**
   * Export filtered data to a file via the storage adapter.
   * @param {object} [filter={}]
   * @param {{ dir?: string, name?: string, format?: "json"|"csv" }} [options]
   */
  export(filter = {}, options = {}) {
    return exportData(this._ds.data, this.name, filter, options, this._ctx);
  }

  // --- Private helpers -----------------------------------------------------

  /**
   * Lazy snapshot for transactions: snapshot this collection on first write.
   * Only participates for a Collection carrying explicit transaction ownership.
   * Ordinary Collection handles skip the snapshot path entirely.
   */
  _txSnapshotIfNeeded() {
    const txm = this._ctx.txManager;
    if (!this._ctx._transaction) return;
    txm._assertOwner(this._ctx._transaction);
    txm.snapshotIfNeeded(this.name, this._store, (col) => this._ctx.snapshotCollection(col));
  }

  /**
   * Save if `save` is explicitly true, or if database-level autoSave is on.
   * Pass `save: false` to opt out even when autoSave is enabled.
   * Suppressed for writes carrying an explicit transaction context -
   * the transaction is responsible for the single flush after fn() resolves.
   * Non-transactional writes save immediately even during an active transaction.
   * @param {boolean|undefined} save
   */
  async _saveIfNeeded(save) {
    if (this._ctx._transaction) {
      this._ctx.txManager._assertOwner(this._ctx._transaction);
      return;
    }
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
        // pipelines. `warn` does NOT prevent invalid data from being persisted.
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
   * Keep candidate references for recovery. On a synchronous failure, restore
   * the pre-eviction array and rebuild indexes before rethrowing.
   *
   * @returns {object[]} The evicted documents (for caller-side event emission).
   */
  _enforceCapAfterInsert() {
    const max = this._maxDocs;
    if (!max || this._ds.count() <= max) return [];
    const evictCount = this._ds.count() - max;
    const toEvict = this._ds.slice(0, evictCount);

    const count = this._ds.count();
    try {
      for (const doc of toEvict) {
        this._ds.deleteFromIndex(doc._id);
        this._removeFromIndex(doc);
      }
      this._ds.spliceRange(0, evictCount);
      return toEvict;
    } catch (error) {
      const previous = this._ds.count() < count ? toEvict.concat(this._ds.data) : this._ds.data;
      this._recoverCommit(error, previous);
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

  // --- Rehydrate (changelog restore) ---------------------------------------

  /**
   * Restore archived documents through the mutation pipeline. Preserve system
   * fields without schema coercion, embedding, hooks or capacity enforcement.
   * Index candidates are checked before mutation. Dirty tracking, transaction
   * locks and saving remain active. Emit deletes then inserts after saving.
   * @param {object[]} docs - Archived final-state documents.
   * @returns {Promise<void>}
   */
  async _rehydrateAll(docs) {
    await this._pipeline.execute({
      op: Ops.RESTORE,
      save: true,
      replay: true,
      mutate: assertTxAlive => {
        const previous = this._ds.data.slice();
        const replacement = structuredClone(docs);
        if (this._fieldIndex) {
          this._fieldIndex.assertUniqueBatch(replacement, { replacing: true });
        }
        assertTxAlive();
        try {
          this._ds.replaceAll(replacement);
          this._fieldIndex?.buildFromData(replacement);
        } catch (error) { this._recoverCommit(error, previous); }
        return {
          docs: replacement,
          emitEvents: () => {
            for (const doc of previous) {
              this._ctx.emitEvent(this.name, { op: Ops.DELETE, collection: this.name, doc: stripVector(doc) });
            }
            for (const doc of replacement) {
              this._ctx.emitEvent(this.name, { op: Ops.INSERT, collection: this.name, doc: stripVector(doc) });
            }
          },
        };
      },
    });
  }

  /**
   * Restore one archived document through the same guarded save lifecycle.
   * Preserve archived fields exactly. Emit the observed delete/update/insert
   * transition after saving. Do not record replay in the changelog.
   * @param {string} id - Document ID.
   * @param {object|null} archived - Historical document, or null for deletion.
   * @returns {Promise<void>}
   */
  async _rehydrateOne(id, archived) {
    await this._pipeline.execute({
      op: Ops.RESTORE,
      save: true,
      replay: true,
      mutate: assertTxAlive => {
        const existing = this._ds.getById(id);
        let doc, op;
        assertTxAlive();
        if (archived == null) {
          if (!existing) return { docs: [] };
          const idx = this._ds.indexOf(existing);
          if (idx === -1) return { docs: [] };
          this._commitDeletedDoc(existing, idx);
          doc = existing;
          op = Ops.DELETE;
        } else {
          doc = structuredClone(archived);
          if (existing) {
            this._commitUpdatedDoc(existing, doc);
            op = Ops.UPDATE;
          } else {
            this._commitInsertedDocs([doc]);
            op = Ops.INSERT;
          }
        }
        return {
          docs: [doc],
          emitEvents: () => {
            this._ctx.emitEvent(this.name, { op, collection: this.name, doc: stripVector(doc) });
          },
        };
      },
    });
  }

  /** Commit a single removal, restoring its original position after failure. */
  _commitDeletedDoc(doc, idx) {
    const count = this._ds.count();
    try {
      this._ds.spliceAt(idx);
      this._removeFromIndex(doc);
    } catch (error) {
      const previous = this._ds.data.slice();
      if (previous.length < count) previous.splice(idx, 0, doc);
      this._recoverCommit(error, previous);
    }
  }

  /** Commit prepared inserts. Retain only potential FIFO victims on the success path. */
  _commitInsertedDocs(docs, batch = false, enforceCap = false) {
    const count = this._ds.count();
    const evictCount = enforceCap && this._maxDocs ? Math.max(0, count + docs.length - this._maxDocs) : 0;
    const prefix = evictCount ? this._ds.slice(0, Math.min(count, evictCount)) : null;
    try {
      if (batch) this._fieldIndex?._addBatch(docs);
      else this._addToIndex(docs[0]);
      this._ds.push(...docs);
      return enforceCap ? this._enforceCapAfterInsert() : [];
    } catch (error) {
      const inserted = new Set(docs);
      let previous = this._ds.data.filter(doc => !inserted.has(doc));
      if (prefix?.length && !previous.includes(prefix[0])) previous = prefix.concat(previous);
      this._recoverCommit(error, previous);
    }
  }

  /** Rebuild primary and secondary indexes from restored documents on a failed commit. */
  _recoverCommit(error, previous) {
    try {
      this._ds.replaceAll(previous);
      this._fieldIndex?.buildFromData(previous);
    } catch (recoveryError) {
      const failure = new SkalexError("ERR_SKALEX_MUTATION_RECOVERY", "Mutation recovery failed. Discard this instance and reopen verified storage.", {
        collection: this.name, mutationError: error, recoveryError,
      });
      this._store._recoveryError = failure;
      throw failure;
    }
    throw error;
  }

  // --- Private index helpers ------------------------------------------------

  _addToIndex(doc) {
    if (this._fieldIndex) this._fieldIndex.add(doc);
  }

  _removeFromIndex(doc) {
    if (this._fieldIndex) this._fieldIndex.remove(doc);
  }

  _updateInIndex(oldDoc, doc) {
    if (this._fieldIndex) this._fieldIndex.update(oldDoc, doc);
  }

  // --- Private document construction ---------------------------------------

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

  /** Clone an explicitly detached read result, preserving the typed error surface. */
  _cloneReadResult(value) {
    try { return structuredClone(value); }
    catch (cause) {
      throw new QueryError("ERR_SKALEX_QUERY_CLONE", "Cannot clone query result. Select cloneable fields or omit clone.", { collection: this.name, cause });
    }
  }

  // --- Private projection / population helpers ------------------------------

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
