/**
 * OpenAIEmbeddingAdapter — generates embeddings via the OpenAI API.
 *
 * Default model: text-embedding-3-small (1536 dimensions, fast and cheap).
 * Requires Node >=18 / Bun / Deno / browser (uses native fetch).
 */
const EmbeddingAdapter = require("./base");

class OpenAIEmbeddingAdapter extends EmbeddingAdapter {
  /**
   * @param {object} config
   * @param {string} config.apiKey            - OpenAI API key (required).
   * @param {string} [config.model]           - Embedding model. Default: "text-embedding-3-small".
   */
  constructor({ apiKey, model = "text-embedding-3-small" } = {}) {
    super();
    if (!apiKey) throw new Error("OpenAIEmbeddingAdapter requires an apiKey");
    this.apiKey = apiKey;
    this.model = model;
  }

  async embed(text) {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ input: text, model: this.model }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`OpenAI embedding API error ${response.status}: ${err}`);
    }

    const data = await response.json();
    return data.data[0].embedding;
  }
}

module.exports = OpenAIEmbeddingAdapter;
