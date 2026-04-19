/**
 * OpenAILLMAdapter  -  language model adapter using the OpenAI Chat API.
 *
 * Default model: gpt-4o-mini (fast, cheap, supports JSON mode).
 * Uses native fetch  -  no additional dependencies.
 *
 * Environment variables (all optional  -  constructor config takes precedence):
 *   OPENAI_API_KEY       -  API key
 *   OPENAI_MODEL         -  chat model name
 *   OPENAI_BASE_URL      -  full endpoint URL (useful for proxies / OpenAI-compatible APIs)
 *   OPENAI_MAX_TOKENS    -  max tokens for responses
 *   OPENAI_TEMPERATURE   -  sampling temperature for summarize() (default: 0.3)
 *   OPENAI_TOP_P         -  nucleus sampling for summarize()
 *   OPENAI_ORGANIZATION  -  OpenAI organization ID
 *   OPENAI_TIMEOUT       -  request timeout in ms
 *   OPENAI_RETRIES       -  number of retry attempts on failure (default: 0)
 *   OPENAI_RETRY_DELAY   -  base retry delay in ms, doubles each attempt (default: 1000)
 *   OPENAI_SEED          -  seed for deterministic outputs
 */
import LLMAdapter from "./base.js";
import { SYSTEM_GENERATE, SYSTEM_SUMMARIZE } from "./prompts.js";
import { AdapterError } from "../../engine/errors.js";
import { fetchWithRetry } from "../shared/fetch.js";

const _env = k => globalThis.process?.env?.[k] ?? globalThis.Deno?.env?.get(k);

class OpenAILLMAdapter extends LLMAdapter {
  /**
   * @param {object} [config]
   * @param {string}   [config.apiKey]       - OpenAI API key. Falls back to OPENAI_API_KEY env var.
   * @param {string}   [config.model]        - Chat model. Default: "gpt-4o-mini". Falls back to OPENAI_MODEL env var.
   * @param {string}   [config.baseUrl]      - API endpoint. Default: "https://api.openai.com/v1/chat/completions". Falls back to OPENAI_BASE_URL env var.
   * @param {number}   [config.maxTokens]    - Max tokens for responses. Falls back to OPENAI_MAX_TOKENS env var.
   * @param {number}   [config.temperature]  - Sampling temperature for summarize(). Default: 0.3. generate() always uses 0. Falls back to OPENAI_TEMPERATURE env var.
   * @param {number}   [config.topP]         - Nucleus sampling for summarize(). Falls back to OPENAI_TOP_P env var.
   * @param {string}   [config.organization] - OpenAI organization ID. Falls back to OPENAI_ORGANIZATION env var.
   * @param {number}   [config.timeout]      - Request timeout in ms. Falls back to OPENAI_TIMEOUT env var.
   * @param {number}   [config.retries]         - Retry attempts on failure. Default: 0. Falls back to OPENAI_RETRIES env var.
   * @param {number}   [config.retryDelay]      - Base retry delay in ms (doubles each attempt). Default: 1000. Falls back to OPENAI_RETRY_DELAY env var.
   * @param {object}   [config.headers]         - Custom headers merged into every request.
   * @param {Function} [config.fetch]           - Custom fetch implementation. Default: globalThis.fetch.
   * @param {number}   [config.seed]            - Seed for deterministic outputs. Falls back to OPENAI_SEED env var.
   * @param {string}   [config.generatePrompt]  - System prompt for generate(). Defaults to built-in query-assistant prompt. Schema is always appended.
   * @param {string}   [config.summarizePrompt] - System prompt for summarize(). Defaults to built-in summarization prompt.
   */
  constructor({
    apiKey          = _env("OPENAI_API_KEY"),
    model           = _env("OPENAI_MODEL")        ?? "gpt-4o-mini",
    baseUrl         = _env("OPENAI_BASE_URL")     ?? "https://api.openai.com/v1/chat/completions",
    maxTokens       = _env("OPENAI_MAX_TOKENS")   != null ? Number(_env("OPENAI_MAX_TOKENS"))   : undefined,
    temperature     = Number(_env("OPENAI_TEMPERATURE") ?? 0.3),
    topP            = _env("OPENAI_TOP_P")        != null ? Number(_env("OPENAI_TOP_P"))        : undefined,
    organization    = _env("OPENAI_ORGANIZATION") ?? undefined,
    timeout         = _env("OPENAI_TIMEOUT")      != null ? Number(_env("OPENAI_TIMEOUT"))      : undefined,
    retries         = Number(_env("OPENAI_RETRIES")     ?? 0),
    retryDelay      = Number(_env("OPENAI_RETRY_DELAY") ?? 1000),
    headers         = {},
    fetch: fetchFn  = globalThis.fetch,
    seed            = _env("OPENAI_SEED") != null ? Number(_env("OPENAI_SEED")) : undefined,
    generatePrompt  = SYSTEM_GENERATE,
    summarizePrompt = SYSTEM_SUMMARIZE,
  } = {}) {
    super();
    if (!apiKey) throw new AdapterError("ERR_SKALEX_ADAPTER_MISSING_API_KEY", "OpenAILLMAdapter requires an apiKey");
    this.apiKey          = apiKey;
    this.model           = model;
    this.baseUrl         = baseUrl;
    this.maxTokens       = maxTokens;
    this.temperature     = temperature;
    this.topP            = topP;
    this.organization    = organization;
    this.timeout         = timeout;
    this.retries         = retries;
    this.retryDelay      = retryDelay;
    this.headers         = headers;
    this._fetch          = fetchFn;
    this.seed            = seed;
    this.generatePrompt  = generatePrompt;
    this.summarizePrompt = summarizePrompt;
  }

  async generate(schema, nlQuery) {
    const data = await this._post({
      model: this.model,
      messages: [
        { role: "system", content: `${this.generatePrompt}\nSchema: ${JSON.stringify(schema)}` },
        { role: "user", content: nlQuery },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
      ...(this.maxTokens !== undefined && { max_tokens: this.maxTokens }),
      ...(this.seed      !== undefined && { seed:       this.seed }),
    });
    return JSON.parse(data.choices[0].message.content);
  }

  async summarize(texts) {
    const data = await this._post({
      model: this.model,
      messages: [
        {
          role: "system",
          content: this.summarizePrompt,
        },
        { role: "user", content: texts },
      ],
      temperature: this.temperature,
      ...(this.maxTokens !== undefined && { max_tokens: this.maxTokens }),
      ...(this.topP      !== undefined && { top_p:      this.topP }),
      ...(this.seed      !== undefined && { seed:       this.seed }),
    });
    return data.choices[0].message.content.trim();
  }

  async _post(body) {
    const response = await fetchWithRetry(this.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
        ...(this.organization && { "OpenAI-Organization": this.organization }),
        ...this.headers,
      },
      body: JSON.stringify(body),
    }, { retries: this.retries, retryDelay: this.retryDelay, timeout: this.timeout, fetchFn: this._fetch });
    if (!response.ok) {
      const err = (await response.text()).slice(0, 200);
      throw new AdapterError("ERR_SKALEX_ADAPTER_HTTP", `OpenAI API error ${response.status}: ${err}`, { status: response.status, adapter: "openai" });
    }
    return response.json();
  }
}

export default OpenAILLMAdapter;
