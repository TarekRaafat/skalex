/**
 * OllamaEmbeddingAdapter — generates embeddings via a local Ollama server.
 *
 * Default model: nomic-embed-text (768 dimensions).
 * Default host:  http://localhost:11434
 *
 * Run locally with: ollama pull nomic-embed-text
 */
const EmbeddingAdapter = require("./base");

class OllamaEmbeddingAdapter extends EmbeddingAdapter {
  /**
   * @param {object} [config]
   * @param {string} [config.model]  - Ollama model name. Default: "nomic-embed-text".
   * @param {string} [config.host]   - Ollama server URL. Default: "http://localhost:11434".
   */
  constructor({ model = "nomic-embed-text", host = "http://localhost:11434" } = {}) {
    super();
    this.model = model;
    this.host = host;
  }

  async embed(text) {
    const response = await fetch(`${this.host}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, prompt: text }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Ollama embedding API error ${response.status}: ${err}`);
    }

    const data = await response.json();
    return data.embedding;
  }
}

module.exports = OllamaEmbeddingAdapter;
