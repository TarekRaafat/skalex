/**
 * OllamaAIAdapter — language model adapter using a local Ollama server.
 *
 * Default model: llama3.2
 * Default host:  http://localhost:11434
 *
 * Run locally: ollama pull llama3.2
 */
const AIAdapter = require("./base");

class OllamaAIAdapter extends AIAdapter {
  /**
   * @param {object} [config]
   * @param {string} [config.model] - Ollama model name. Default: "llama3.2".
   * @param {string} [config.host]  - Ollama server URL. Default: "http://localhost:11434".
   */
  constructor({ model = "llama3.2", host = "http://localhost:11434" } = {}) {
    super();
    this.model = model;
    this.host = host;
  }

  async generate(schema, nlQuery) {
    const prompt = [
      "You are a database query translator.",
      "Given a JSON schema and a natural language query, return a valid JSON filter object.",
      "Only reference fields that exist in the schema.",
      "Supported operators: $eq, $ne, $gt, $gte, $lt, $lte, $in, $nin.",
      'For regex: { "field": { "$regex": "pattern" } } — value must be a string.',
      "Return ONLY the JSON object. No explanation.",
      `Schema: ${JSON.stringify(schema)}`,
      `Query: ${nlQuery}`,
      "JSON filter:",
    ].join("\n");

    const response = await fetch(`${this.host}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, prompt, format: "json", stream: false }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Ollama API error ${response.status}: ${err}`);
    }

    const data = await response.json();
    return JSON.parse(data.response);
  }

  async summarize(texts) {
    const response = await fetch(`${this.host}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        prompt: `Summarise the following memory entries into one concise paragraph. Preserve all important facts.\n\n${texts}`,
        stream: false,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Ollama API error ${response.status}: ${err}`);
    }

    const data = await response.json();
    return data.response.trim();
  }
}

module.exports = OllamaAIAdapter;
