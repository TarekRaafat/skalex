/** Average characters per token (GPT-style 4-char heuristic). */
const CHARS_PER_TOKEN = 4;

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
    if (maxEntries && this._col._data.length > maxEntries) {
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
   * @returns {Promise<object|null>}
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
    const tokens = data.reduce((sum, d) => sum + this._docTokens(d), 0);
    return { tokens, count: data.length };
  }

  /**
   * Return memories as a newline-joined string, newest-first, capped to a token budget.
   * @param {{ tokens?: number }} [opts]
   * @returns {string}
   */
  context({ tokens = this._db._memoryConfig?.contextTokens ?? 4000 } = {}) {
    const sorted = this._sortedData("desc");
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
   * Keeps the 10 most recent entries intact; summarises the rest into one entry.
   * @param {{ threshold?: number }} [opts]
   * @returns {Promise<void>}
   */
  async compress({ threshold = this._db._memoryConfig?.compressionThreshold ?? 8000, keepRecent = this._db._memoryConfig?.keepRecent ?? 10 } = {}) {
    const { tokens } = this.tokenCount();
    if (tokens <= threshold) return;

    if (!this._db._aiAdapter) {
      throw new Error(
        "memory.compress() requires a language model adapter. Configure { ai: { model: \"...\" } }."
      );
    }

    const sorted = this._sortedData("asc");

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
   * Return a sorted copy of all memory docs.
   * @param {"asc"|"desc"} direction - "asc" = oldest-first, "desc" = newest-first
   */
  _sortedData(direction) {
    return [...this._col._data].sort(
      direction === "asc"
        ? (a, b) => new Date(a.createdAt) - new Date(b.createdAt)
        : (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    );
  }
}

export default Memory;
