/**
 * MockAIAdapter — in-memory language model adapter for tests.
 *
 * Accepts a `responses` map of nlQuery → filter object.
 * Records all generate() and summarize() calls for assertion.
 */
const AIAdapter = require("../../src/adapters/ai/base.js");

class MockAIAdapter extends AIAdapter {
  /**
   * @param {Record<string, object>} [responses]  - nlQuery → filter overrides.
   */
  constructor(responses = {}) {
    super();
    this._responses = responses;
    this.calls = [];           // generate() call log: [{ schema, nlQuery }]
    this.summarizeCalls = [];  // summarize() call log: [texts]
  }

  async generate(schema, nlQuery) {
    this.calls.push({ schema, nlQuery });
    return this._responses[nlQuery] ?? {};
  }

  async summarize(texts) {
    this.summarizeCalls.push(texts);
    const count = texts.split("\n").filter(Boolean).length;
    return `Summary of ${count} memories.`;
  }
}

module.exports = MockAIAdapter;
