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
import { UniqueConstraintError, ValidationError } from "./errors.js";

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

export default IndexEngine;
