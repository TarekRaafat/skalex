/**
 * registry.js  -  CollectionRegistry for Skalex.
 *
 * Owns collection definitions, store creation, instance caching,
 * renames, inspection, and metadata access.
 */
import IndexEngine from "./indexes.js";
import { parseSchema, inferSchema } from "./validator.js";
import { PersistenceError } from "./errors.js";

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
  }

  /**
   * Get (or lazily create) a Collection instance by name.
   * @param {string} name
   * @param {object} db - The Skalex instance (passed to Collection constructor).
   * @returns {import("./collection.js").default}
   */
  get(name, db) {
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
      const count = col.data.length;
      let estimatedSize = 0;
      for (const doc of col.data) {
        try { estimatedSize += JSON.stringify(doc).length; } catch (_) { }
      }
      return { collection: n, count, estimatedSize, avgDocSize: count > 0 ? Math.round(estimatedSize / count) : 0 };
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
  }
}

export default CollectionRegistry;
