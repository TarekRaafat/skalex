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

export default InMemoryDataStore;
