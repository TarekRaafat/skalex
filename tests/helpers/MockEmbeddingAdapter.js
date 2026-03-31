/**
 * MockEmbeddingAdapter — in-memory embedding adapter for tests.
 *
 * Accepts a `responses` map of text → vector. For unknown text it generates
 * a deterministic 4-dimensional vector from the character codes so tests
 * can assert on score ordering without calling any external API.
 */
import EmbeddingAdapter from "../../src/connectors/embedding/base.js";

class MockEmbeddingAdapter extends EmbeddingAdapter {
  /**
   * @param {Record<string, number[]>} [responses] - text → vector overrides.
   */
  constructor(responses = {}) {
    super();
    this._responses = responses;
    this.calls = []; // record of all embed() calls for assertion
  }

  async embed(text) {
    this.calls.push(text);
    if (this._responses[text]) return this._responses[text];

    // Deterministic fallback: 4-dim vector from char codes
    return Array.from({ length: 4 }, (_, i) =>
      (text.charCodeAt(i % text.length) || 1) / 255
    );
  }
}

export default MockEmbeddingAdapter;
