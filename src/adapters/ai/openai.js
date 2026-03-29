/**
 * OpenAIAIAdapter — language model adapter using the OpenAI Chat API.
 *
 * Default model: gpt-4o-mini (fast, cheap, supports JSON mode).
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
  "Return ONLY the JSON object. No explanation, no markdown.",
].join("\n");

class OpenAIAIAdapter extends AIAdapter {
  /**
   * @param {object} config
   * @param {string} config.apiKey  - OpenAI API key (required).
   * @param {string} [config.model] - Chat model. Default: "gpt-4o-mini".
   */
  constructor({ apiKey, model = "gpt-4o-mini" } = {}) {
    super();
    if (!apiKey) throw new Error("OpenAIAIAdapter requires an apiKey");
    this.apiKey = apiKey;
    this.model = model;
  }

  async generate(schema, nlQuery) {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: `${SYSTEM_GENERATE}\nSchema: ${JSON.stringify(schema)}` },
          { role: "user", content: nlQuery },
        ],
        response_format: { type: "json_object" },
        temperature: 0,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`OpenAI API error ${response.status}: ${err}`);
    }

    const data = await response.json();
    return JSON.parse(data.choices[0].message.content);
  }

  async summarize(texts) {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          {
            role: "system",
            content: "Summarise the following memory entries into one concise paragraph. Preserve all important facts.",
          },
          { role: "user", content: texts },
        ],
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`OpenAI API error ${response.status}: ${err}`);
    }

    const data = await response.json();
    return data.choices[0].message.content.trim();
  }
}

module.exports = OpenAIAIAdapter;
