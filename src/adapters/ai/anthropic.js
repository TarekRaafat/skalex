/**
 * AnthropicAIAdapter — language model adapter using the Anthropic Messages API.
 *
 * Default model: claude-haiku-4-5 (fast and economical).
 * Uses native fetch — no additional dependencies.
 */
const AIAdapter = require("./base");

const SYSTEM_GENERATE = [
  "You are a database query translator.",
  "Given a JSON schema and a natural language query, return a valid JSON filter object.",
  "Only reference fields that exist in the schema.",
  "Supported operators: $eq, $ne, $gt, $gte, $lt, $lte, $in, $nin.",
  'For regex: { "field": { "$regex": "pattern" } } — value must be a string.',
  "For date comparisons use ISO 8601 strings.",
  "Return ONLY the JSON object. No explanation, no markdown, no code fences.",
].join("\n");

class AnthropicAIAdapter extends AIAdapter {
  /**
   * @param {object} config
   * @param {string} config.apiKey  - Anthropic API key (required).
   * @param {string} [config.model] - Model. Default: "claude-haiku-4-5".
   */
  constructor({ apiKey, model = "claude-haiku-4-5" } = {}) {
    super();
    if (!apiKey) throw new Error("AnthropicAIAdapter requires an apiKey");
    this.apiKey = apiKey;
    this.model = model;
  }

  async generate(schema, nlQuery) {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 1024,
        system: `${SYSTEM_GENERATE}\nSchema: ${JSON.stringify(schema)}`,
        messages: [{ role: "user", content: nlQuery }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${err}`);
    }

    const data = await response.json();
    const text = data.content[0].text.trim()
      .replace(/^```(?:json)?\n?/, "")
      .replace(/\n?```$/, "");
    return JSON.parse(text);
  }

  async summarize(texts) {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 512,
        system: "Summarise the following memory entries into one concise paragraph. Preserve all important facts.",
        messages: [{ role: "user", content: texts }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${err}`);
    }

    const data = await response.json();
    return data.content[0].text.trim();
  }
}

module.exports = AnthropicAIAdapter;
