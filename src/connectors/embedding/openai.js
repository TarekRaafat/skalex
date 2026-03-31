/**
 * OpenAIEmbeddingAdapter — generates embeddings via the OpenAI API.
 *
 * Default model: text-embedding-3-small (1536 dimensions, fast and cheap).
 * Requires Node >=18 / Bun / Deno / browser (uses native fetch).
 *
 * Environment variables (all optional — constructor config takes precedence):
 *   OPENAI_API_KEY           — API key
 *   OPENAI_EMBED_MODEL       — embedding model name
 *   OPENAI_EMBED_BASE_URL    — full endpoint URL (useful for proxies / OpenAI-compatible APIs)
 *   OPENAI_EMBED_DIMENSIONS  — output vector dimensions (text-embedding-3-* only)
 *   OPENAI_ORGANIZATION      — OpenAI organization ID
 *   OPENAI_EMBED_TIMEOUT     — request timeout in ms
 *   OPENAI_EMBED_RETRIES     — number of retry attempts on failure (default: 0)
 *   OPENAI_EMBED_RETRY_DELAY — base retry delay in ms, doubles each attempt (default: 1000)
 */
import EmbeddingAdapter from "./base.js";

const _env = k => globalThis.process?.env?.[k] ?? globalThis.Deno?.env?.get(k);

class OpenAIEmbeddingAdapter extends EmbeddingAdapter {
  /**
   * @param {object}   [config]
   * @param {string}   [config.apiKey]       - OpenAI API key. Falls back to OPENAI_API_KEY env var.
   * @param {string}   [config.model]        - Embedding model. Default: "text-embedding-3-small". Falls back to OPENAI_EMBED_MODEL env var.
   * @param {string}   [config.baseUrl]      - API endpoint. Default: "https://api.openai.com/v1/embeddings". Falls back to OPENAI_EMBED_BASE_URL env var.
   * @param {number}   [config.dimensions]   - Output vector dimensions (text-embedding-3-* only). Falls back to OPENAI_EMBED_DIMENSIONS env var.
   * @param {string}   [config.organization] - OpenAI organization ID. Falls back to OPENAI_ORGANIZATION env var.
   * @param {number}   [config.timeout]      - Request timeout in ms. Falls back to OPENAI_EMBED_TIMEOUT env var.
   * @param {number}   [config.retries]      - Retry attempts on failure. Default: 0. Falls back to OPENAI_EMBED_RETRIES env var.
   * @param {number}   [config.retryDelay]   - Base retry delay in ms (doubles each attempt). Default: 1000. Falls back to OPENAI_EMBED_RETRY_DELAY env var.
   * @param {object}   [config.headers]      - Custom headers merged into every request.
   * @param {Function} [config.fetch]        - Custom fetch implementation. Default: globalThis.fetch.
   */
  constructor({
    apiKey       = _env("OPENAI_API_KEY"),
    model        = _env("OPENAI_EMBED_MODEL")      ?? "text-embedding-3-small",
    baseUrl      = _env("OPENAI_EMBED_BASE_URL")   ?? "https://api.openai.com/v1/embeddings",
    dimensions   = _env("OPENAI_EMBED_DIMENSIONS") != null ? Number(_env("OPENAI_EMBED_DIMENSIONS")) : undefined,
    organization = _env("OPENAI_ORGANIZATION")     ?? undefined,
    timeout      = _env("OPENAI_EMBED_TIMEOUT")    != null ? Number(_env("OPENAI_EMBED_TIMEOUT"))    : undefined,
    retries      = Number(_env("OPENAI_EMBED_RETRIES")      ?? 0),
    retryDelay   = Number(_env("OPENAI_EMBED_RETRY_DELAY")  ?? 1000),
    headers      = {},
    fetch: fetchFn = globalThis.fetch,
  } = {}) {
    super();
    if (!apiKey) throw new Error("OpenAIEmbeddingAdapter requires an apiKey");
    this.apiKey       = apiKey;
    this.model        = model;
    this.baseUrl      = baseUrl;
    this.dimensions   = dimensions;
    this.organization = organization;
    this.timeout      = timeout;
    this.retries      = retries;
    this.retryDelay   = retryDelay;
    this.headers      = headers;
    this._fetch       = fetchFn;
  }

  async embed(text) {
    let lastErr;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const controller = this.timeout != null ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), this.timeout) : null;
      try {
        const response = await this._fetch(this.baseUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${this.apiKey}`,
            ...(this.organization && { "OpenAI-Organization": this.organization }),
            ...this.headers,
          },
          body: JSON.stringify({
            input: text,
            model: this.model,
            ...(this.dimensions !== undefined && { dimensions: this.dimensions }),
          }),
          ...(controller && { signal: controller.signal }),
        });
        if (!response.ok) {
          const err = (await response.text()).slice(0, 200);
          throw new Error(`OpenAI embedding API error ${response.status}: ${err}`);
        }
        const data = await response.json();
        return data.data[0].embedding;
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

export default OpenAIEmbeddingAdapter;
