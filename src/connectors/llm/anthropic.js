/**
 * AnthropicLLMAdapter  -  language model adapter using the Anthropic Messages API.
 *
 * Default model: claude-haiku-4-5 (fast and economical).
 * Uses native fetch  -  no additional dependencies.
 *
 * Environment variables (all optional  -  constructor config takes precedence):
 *   ANTHROPIC_API_KEY      -  API key
 *   ANTHROPIC_MODEL        -  model name
 *   ANTHROPIC_BASE_URL     -  full endpoint URL (useful for proxies / Anthropic-compatible APIs)
 *   ANTHROPIC_MAX_TOKENS   -  max tokens for responses (default: 1024)
 *   ANTHROPIC_TEMPERATURE  -  sampling temperature for summarize() (default: 0.3)
 *   ANTHROPIC_TOP_P        -  nucleus sampling for summarize()
 *   ANTHROPIC_TOP_K        -  top-K sampling for summarize()
 *   ANTHROPIC_TIMEOUT      -  request timeout in ms
 *   ANTHROPIC_RETRIES      -  number of retry attempts on failure (default: 0)
 *   ANTHROPIC_RETRY_DELAY  -  base retry delay in ms, doubles each attempt (default: 1000)
 */
import LLMAdapter from "./base.js";
import { SYSTEM_GENERATE, SYSTEM_SUMMARIZE } from "./prompts.js";

const _env = k => globalThis.process?.env?.[k] ?? globalThis.Deno?.env?.get(k);

class AnthropicLLMAdapter extends LLMAdapter {
  /**
   * @param {object}   [config]
   * @param {string}   [config.apiKey]      - Anthropic API key. Falls back to ANTHROPIC_API_KEY env var.
   * @param {string}   [config.model]       - Model name. Default: "claude-haiku-4-5". Falls back to ANTHROPIC_MODEL env var.
   * @param {string}   [config.baseUrl]     - API endpoint. Default: "https://api.anthropic.com/v1/messages". Falls back to ANTHROPIC_BASE_URL env var.
   * @param {string}   [config.apiVersion]  - Anthropic-Version header. Default: "2023-06-01".
   * @param {number}   [config.maxTokens]   - Max tokens for responses. Default: 1024. Falls back to ANTHROPIC_MAX_TOKENS env var.
   * @param {number}   [config.temperature] - Sampling temperature for summarize(). Default: 0.3. generate() always uses 0. Falls back to ANTHROPIC_TEMPERATURE env var.
   * @param {number}   [config.topP]        - Nucleus sampling for summarize(). Falls back to ANTHROPIC_TOP_P env var.
   * @param {number}   [config.topK]        - Top-K sampling for summarize(). Falls back to ANTHROPIC_TOP_K env var.
   * @param {number}   [config.timeout]     - Request timeout in ms. Falls back to ANTHROPIC_TIMEOUT env var.
   * @param {number}   [config.retries]         - Retry attempts on failure. Default: 0. Falls back to ANTHROPIC_RETRIES env var.
   * @param {number}   [config.retryDelay]      - Base retry delay in ms (doubles each attempt). Default: 1000. Falls back to ANTHROPIC_RETRY_DELAY env var.
   * @param {object}   [config.headers]         - Custom headers merged into every request.
   * @param {Function} [config.fetch]           - Custom fetch implementation. Default: globalThis.fetch.
   * @param {string}   [config.generatePrompt]  - System prompt for generate(). Defaults to built-in query-assistant prompt. Schema is always appended.
   * @param {string}   [config.summarizePrompt] - System prompt for summarize(). Defaults to built-in summarization prompt.
   */
  constructor({
    apiKey          = _env("ANTHROPIC_API_KEY"),
    model           = _env("ANTHROPIC_MODEL")       ?? "claude-haiku-4-5",
    baseUrl         = _env("ANTHROPIC_BASE_URL")    ?? "https://api.anthropic.com/v1/messages",
    apiVersion      = "2023-06-01",
    maxTokens       = Number(_env("ANTHROPIC_MAX_TOKENS")   ?? 1024),
    temperature     = Number(_env("ANTHROPIC_TEMPERATURE")  ?? 0.3),
    topP            = _env("ANTHROPIC_TOP_P")    != null ? Number(_env("ANTHROPIC_TOP_P"))    : undefined,
    topK            = _env("ANTHROPIC_TOP_K")    != null ? Number(_env("ANTHROPIC_TOP_K"))    : undefined,
    timeout         = _env("ANTHROPIC_TIMEOUT")  != null ? Number(_env("ANTHROPIC_TIMEOUT"))  : undefined,
    retries         = Number(_env("ANTHROPIC_RETRIES")     ?? 0),
    retryDelay      = Number(_env("ANTHROPIC_RETRY_DELAY") ?? 1000),
    headers         = {},
    fetch: fetchFn  = globalThis.fetch,
    generatePrompt  = SYSTEM_GENERATE,
    summarizePrompt = SYSTEM_SUMMARIZE,
  } = {}) {
    super();
    if (!apiKey) throw new Error("AnthropicLLMAdapter requires an apiKey");
    this.apiKey          = apiKey;
    this.model           = model;
    this.baseUrl         = baseUrl;
    this.apiVersion      = apiVersion;
    this.maxTokens       = maxTokens;
    this.temperature     = temperature;
    this.topP            = topP;
    this.topK            = topK;
    this.timeout         = timeout;
    this.retries         = retries;
    this.retryDelay      = retryDelay;
    this.headers         = headers;
    this._fetch          = fetchFn;
    this.generatePrompt  = generatePrompt;
    this.summarizePrompt = summarizePrompt;
  }

  async generate(schema, nlQuery) {
    const data = await this._post({
      model: this.model,
      max_tokens: this.maxTokens,
      temperature: 0,
      system: `${this.generatePrompt}\nSchema: ${JSON.stringify(schema)}`,
      messages: [{ role: "user", content: nlQuery }],
    });
    const text = data.content[0].text.trim()
      .replace(/^```(?:json)?\n?/, "")
      .replace(/\n?```$/, "");
    return JSON.parse(text);
  }

  async summarize(texts) {
    const data = await this._post({
      model: this.model,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      ...(this.topP !== undefined && { top_p: this.topP }),
      ...(this.topK !== undefined && { top_k: this.topK }),
      system: this.summarizePrompt,
      messages: [{ role: "user", content: texts }],
    });
    return data.content[0].text.trim();
  }

  async _post(body) {
    let lastErr;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const controller = this.timeout != null ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), this.timeout) : null;
      try {
        const response = await this._fetch(this.baseUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": this.apiKey,
            "anthropic-version": this.apiVersion,
            ...this.headers,
          },
          body: JSON.stringify(body),
          ...(controller && { signal: controller.signal }),
        });
        if (!response.ok) {
          const err = (await response.text()).slice(0, 200);
          throw new Error(`Anthropic API error ${response.status}: ${err}`);
        }
        return response.json();
      } catch (err) {
        lastErr = err;
        if (attempt < this.retries) {
          await new Promise(r => setTimeout(r, this.retryDelay * 2 ** attempt));
        }
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
    }
    throw lastErr;
  }
}

export default AnthropicLLMAdapter;
