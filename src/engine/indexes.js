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
class IndexEngine {
  /**
   * @param {string[]} fields   - Fields to index (non-unique)
   * @param {string[]} unique   - Fields with unique constraint
   */
  constructor(fields = [], unique = []) {
    this._fields = new Set(fields);
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
      // and it is NOT the same document being updated.
      // Compare by _id so this is robust whether existingDoc is the original
      // object reference or a shallow copy made before mutation.
      if (existing && existing._id !== existingDoc?._id) {
        throw new Error(`Unique constraint violation: field "${field}" value "${val}" already exists`);
      }
    }
  }
}

export default IndexEngine;
