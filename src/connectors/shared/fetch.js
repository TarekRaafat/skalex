/**
 * fetch.js - shared fetch-with-retry utility for all AI adapters.
 *
 * Centralises retry/timeout/exponential-backoff logic so each adapter
 * only defines its URL, headers, and response handling. Zero runtime
 * dependencies - uses globalThis.fetch and AbortController.
 */

/**
 * Fetch a URL with retry, timeout, and exponential backoff.
 *
 * @param {string} url
 * @param {RequestInit} options - Standard fetch options (method, headers, body, etc.).
 * @param {object} [retryOpts]
 * @param {number} [retryOpts.retries=0] - Number of retry attempts. 0 = no retries.
 * @param {number} [retryOpts.retryDelay=1000] - Base delay in ms (doubles each attempt).
 * @param {number|null} [retryOpts.timeout=null] - Per-request timeout in ms. null = no timeout.
 * @param {typeof globalThis.fetch} [retryOpts.fetchFn=globalThis.fetch] - Fetch implementation (for testing).
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url, options, { retries = 0, retryDelay = 1000, timeout = null, fetchFn = globalThis.fetch } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = timeout != null ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeout) : null;
    try {
      const response = await fetchFn(url, {
        ...options,
        ...(controller && { signal: controller.signal }),
      });
      return response;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, retryDelay * 2 ** attempt));
      }
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }
  throw lastErr;
}

export { fetchWithRetry };
