/**
 * LLMAdapter — interface all language model backends must implement.
 *
 * Used by:
 *   - db.ask(question, collection)  — NL → filter translation
 *   - memory.compress()             — memory summarisation
 */
class LLMAdapter {
  /**
   * Translate a natural language query into a Skalex filter object.
   * @param {object} schema   - Plain { field: type } schema of the target collection.
   * @param {string} nlQuery  - Natural language query string.
   * @returns {Promise<object>} A filter object compatible with matchesFilter().
   */
  async generate(schema, nlQuery) {
    throw new Error("LLMAdapter.generate() not implemented");
  }

  /**
   * Summarise multiple memory text entries into a single paragraph.
   * @param {string} texts  - Newline-separated memory entries.
   * @returns {Promise<string>}
   */
  async summarize(texts) {
    throw new Error("LLMAdapter.summarize() not implemented");
  }
}

export default LLMAdapter;
