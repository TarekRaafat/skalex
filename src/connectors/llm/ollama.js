/**
 * OllamaLLMAdapter  -  language model adapter using a local Ollama server.
 *
 * Default model: llama3.2
 * Default host:  http://localhost:11434
 *
 * Run locally: ollama pull llama3.2
 *
 * Environment variables (all optional  -  constructor config takes precedence):
 *   OLLAMA_HOST         -  Ollama server URL
 *   OLLAMA_MODEL        -  model name
 *   OLLAMA_TEMPERATURE  -  sampling temperature for summarize() (default: 0.3)
 *   OLLAMA_TOP_P        -  nucleus sampling for summarize()
 *   OLLAMA_TOP_K        -  top-K sampling for summarize()
 *   OLLAMA_TIMEOUT      -  request timeout in ms
 *   OLLAMA_RETRIES      -  number of retry attempts on failure (default: 0)
 *   OLLAMA_RETRY_DELAY  -  base retry delay in ms, doubles each attempt (default: 1000)
 */
import LLMAdapter from "./base.js";
import { SYSTEM_GENERATE, SYSTEM_SUMMARIZE } from "./prompts.js";

const _env = k => globalThis.process?.env?.[k] ?? globalThis.Deno?.env?.get(k);

class OllamaLLMAdapter extends LLMAdapter {
  /**
   * @param {object}   [config]
   * @param {string}   [config.model]       - Ollama model name. Default: "llama3.2". Falls back to OLLAMA_MODEL env var.
   * @param {string}   [config.host]        - Ollama server URL. Default: "http://localhost:11434". Falls back to OLLAMA_HOST env var.
   * @param {number}   [config.temperature] - Sampling temperature for summarize(). Default: 0.3. generate() always uses 0. Falls back to OLLAMA_TEMPERATURE env var.
   * @param {number}   [config.topP]        - Nucleus sampling for summarize(). Falls back to OLLAMA_TOP_P env var.
   * @param {number}   [config.topK]        - Top-K sampling for summarize(). Falls back to OLLAMA_TOP_K env var.
   * @param {number}   [config.timeout]     - Request timeout in ms. Falls back to OLLAMA_TIMEOUT env var.
   * @param {number}   [config.retries]         - Retry attempts on failure. Default: 0. Falls back to OLLAMA_RETRIES env var.
   * @param {number}   [config.retryDelay]      - Base retry delay in ms (doubles each attempt). Default: 1000. Falls back to OLLAMA_RETRY_DELAY env var.
   * @param {object}   [config.headers]         - Custom headers merged into every request.
   * @param {Function} [config.fetch]           - Custom fetch implementation. Default: globalThis.fetch.
   * @param {string}   [config.generatePrompt]  - System prompt for generate(). Defaults to built-in query-assistant prompt. Schema and query are always appended.
   * @param {string}   [config.summarizePrompt] - System prompt prefix for summarize(). Defaults to built-in summarization prompt.
   */
  constructor({
    model           = _env("OLLAMA_MODEL") ?? "llama3.2",
    host            = _env("OLLAMA_HOST")  ?? "http://localhost:11434",
    temperature     = Number(_env("OLLAMA_TEMPERATURE") ?? 0.3),
    topP            = _env("OLLAMA_TOP_P")    != null ? Number(_env("OLLAMA_TOP_P"))    : undefined,
    topK            = _env("OLLAMA_TOP_K")    != null ? Number(_env("OLLAMA_TOP_K"))    : undefined,
    timeout         = _env("OLLAMA_TIMEOUT")  != null ? Number(_env("OLLAMA_TIMEOUT"))  : undefined,
    retries         = Number(_env("OLLAMA_RETRIES")     ?? 0),
    retryDelay      = Number(_env("OLLAMA_RETRY_DELAY") ?? 1000),
    headers         = {},
    fetch: fetchFn  = globalThis.fetch,
    generatePrompt  = SYSTEM_GENERATE,
    summarizePrompt = SYSTEM_SUMMARIZE,
  } = {}) {
    super();
    this.model           = model;
    this.host            = host;
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
    const prompt = `${this.generatePrompt}\nSchema: ${JSON.stringify(schema)}\nQuery: ${nlQuery}`;
    const data = await this._post({
      model: this.model,
      prompt,
      format: "json",
      options: { temperature: 0 },
      stream: false,
    });
    return JSON.parse(data.response);
  }

  async summarize(texts) {
    const data = await this._post({
      model: this.model,
      prompt: `${this.summarizePrompt}\n\n${texts}`,
      options: {
        temperature: this.temperature,
        ...(this.topP !== undefined && { top_p: this.topP }),
        ...(this.topK !== undefined && { top_k: this.topK }),
      },
      stream: false,
    });
    return data.response.trim();
  }

  async _post(body) {
    let lastErr;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const controller = this.timeout != null ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), this.timeout) : null;
      try {
        const response = await this._fetch(`${this.host}/api/generate`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...this.headers,
          },
          body: JSON.stringify(body),
          ...(controller && { signal: controller.signal }),
        });
        if (!response.ok) {
          const err = (await response.text()).slice(0, 200);
          throw new Error(`Ollama API error ${response.status}: ${err}`);
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

export default OllamaLLMAdapter;
