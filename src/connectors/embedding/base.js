import { AdapterError } from "../../engine/errors.js";

/**
 * EmbeddingAdapter  -  interface all embedding backends must implement.
 *
 * embed(text) takes a string and returns a numeric vector (number[]).
 * Vectors are stored inline on documents as the `_vector` field and are
 * stripped from all query results so callers never see them directly.
 */
class EmbeddingAdapter {
  /**
   * Embed a text string into a numeric vector.
   * @param {string} text
   * @returns {Promise<number[]>}
   */
  async embed(text) {
    throw new AdapterError("ERR_SKALEX_ADAPTER_NOT_IMPLEMENTED", "EmbeddingAdapter.embed() not implemented");
  }
}

export default EmbeddingAdapter;
