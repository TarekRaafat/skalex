import { AdapterError } from "./errors.js";
import { QueryCache, processLLMFilter, validateLLMFilter } from "../features/ask.js";

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

export default SkalexAI;
