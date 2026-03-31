/**
 * OllamaEmbeddingAdapter — generates embeddings via a local Ollama server.
 *
 * Default model: nomic-embed-text (768 dimensions).
 * Default host:  http://localhost:11434
 *
 * Run locally with: ollama pull nomic-embed-text
 *
 * Environment variables (all optional — constructor config takes precedence):
 *   OLLAMA_HOST             — Ollama server URL
 *   OLLAMA_EMBED_MODEL      — embedding model name
 *   OLLAMA_EMBED_TIMEOUT    — request timeout in ms
 *   OLLAMA_EMBED_RETRIES    — number of retry attempts on failure (default: 0)
 *   OLLAMA_EMBED_RETRY_DELAY — base retry delay in ms, doubles each attempt (default: 1000)
 */
import EmbeddingAdapter from "./base.js";

const _env = k => globalThis.process?.env?.[k] ?? globalThis.Deno?.env?.get(k);

class OllamaEmbeddingAdapter extends EmbeddingAdapter {
  /**
   * @param {object}   [config]
   * @param {string}   [config.model]      - Ollama model name. Default: "nomic-embed-text". Falls back to OLLAMA_EMBED_MODEL env var.
   * @param {string}   [config.host]       - Ollama server URL. Default: "http://localhost:11434". Falls back to OLLAMA_HOST env var.
   * @param {number}   [config.timeout]    - Request timeout in ms. Falls back to OLLAMA_EMBED_TIMEOUT env var.
   * @param {number}   [config.retries]    - Retry attempts on failure. Default: 0. Falls back to OLLAMA_EMBED_RETRIES env var.
   * @param {number}   [config.retryDelay] - Base retry delay in ms (doubles each attempt). Default: 1000. Falls back to OLLAMA_EMBED_RETRY_DELAY env var.
   * @param {object}   [config.headers]    - Custom headers merged into every request.
   * @param {Function} [config.fetch]      - Custom fetch implementation. Default: globalThis.fetch.
   */
  constructor({
    model      = _env("OLLAMA_EMBED_MODEL")       ?? "nomic-embed-text",
    host       = _env("OLLAMA_HOST")              ?? "http://localhost:11434",
    timeout    = _env("OLLAMA_EMBED_TIMEOUT")     != null ? Number(_env("OLLAMA_EMBED_TIMEOUT"))     : undefined,
    retries    = Number(_env("OLLAMA_EMBED_RETRIES")      ?? 0),
    retryDelay = Number(_env("OLLAMA_EMBED_RETRY_DELAY")  ?? 1000),
    headers    = {},
    fetch: fetchFn = globalThis.fetch,
  } = {}) {
    super();
    this.model      = model;
    this.host       = host;
    this.timeout    = timeout;
    this.retries    = retries;
    this.retryDelay = retryDelay;
    this.headers    = headers;
    this._fetch     = fetchFn;
  }

  async embed(text) {
    let lastErr;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const controller = this.timeout != null ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), this.timeout) : null;
      try {
        const response = await this._fetch(`${this.host}/api/embeddings`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...this.headers,
          },
          body: JSON.stringify({ model: this.model, prompt: text }),
          ...(controller && { signal: controller.signal }),
        });
        if (!response.ok) {
          const err = (await response.text()).slice(0, 200);
          throw new Error(`Ollama embedding API error ${response.status}: ${err}`);
        }
        const data = await response.json();
        return data.embedding;
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

export default OllamaEmbeddingAdapter;
