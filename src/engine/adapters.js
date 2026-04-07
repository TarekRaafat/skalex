/**
 * adapters.js  -  AI adapter factory functions.
 *
 * Pure config-to-instance mappers extracted from Skalex constructor.
 */
import OpenAIEmbeddingAdapter from "../connectors/embedding/openai.js";
import OllamaEmbeddingAdapter from "../connectors/embedding/ollama.js";
import OpenAILLMAdapter from "../connectors/llm/openai.js";
import AnthropicLLMAdapter from "../connectors/llm/anthropic.js";
import OllamaLLMAdapter from "../connectors/llm/ollama.js";
import { AdapterError } from "./errors.js";

/**
 * Create an embedding adapter from AI config.
 * @param {object} ai
 * @returns {import("../connectors/embedding/base.js").default}
 */
function createEmbeddingAdapter({ provider, apiKey, embedModel, model, host, embedBaseUrl, dimensions, organization, embedTimeout, embedRetries, embedRetryDelay }) {
  const resolvedModel = embedModel || model;
  switch (provider) {
    case "openai":
      return new OpenAIEmbeddingAdapter({
        apiKey,
        model: resolvedModel,
        baseUrl: embedBaseUrl,
        ...(dimensions !== undefined && { dimensions }),
        ...(organization !== undefined && { organization }),
        ...(embedTimeout !== undefined && { timeout: embedTimeout }),
        ...(embedRetries !== undefined && { retries: embedRetries }),
        ...(embedRetryDelay !== undefined && { retryDelay: embedRetryDelay }),
      });
    case "ollama":
      return new OllamaEmbeddingAdapter({
        model: resolvedModel,
        host,
        ...(embedTimeout !== undefined && { timeout: embedTimeout }),
        ...(embedRetries !== undefined && { retries: embedRetries }),
        ...(embedRetryDelay !== undefined && { retryDelay: embedRetryDelay }),
      });
    default:
      throw new AdapterError(
        "ERR_SKALEX_ADAPTER_UNKNOWN_PROVIDER",
        `Unknown AI provider: "${provider}". Supported: "openai", "ollama".`,
        { provider }
      );
  }
}

/**
 * Create a language model adapter from AI config.
 * @param {object} ai
 * @returns {import("../connectors/llm/base.js").default|null}
 */
function createLLMAdapter({ provider, apiKey, model, host, baseUrl, apiVersion, temperature, maxTokens, topP, topK, organization, timeout, retries, retryDelay, seed, generatePrompt, summarizePrompt }) {
  if (!model) return null;
  switch (provider) {
    case "openai":
      return new OpenAILLMAdapter({
        apiKey,
        model,
        baseUrl,
        ...(maxTokens !== undefined && { maxTokens }),
        ...(temperature !== undefined && { temperature }),
        ...(topP !== undefined && { topP }),
        ...(organization !== undefined && { organization }),
        ...(timeout !== undefined && { timeout }),
        ...(retries !== undefined && { retries }),
        ...(retryDelay !== undefined && { retryDelay }),
        ...(seed !== undefined && { seed }),
        ...(generatePrompt !== undefined && { generatePrompt }),
        ...(summarizePrompt !== undefined && { summarizePrompt }),
      });
    case "anthropic":
      return new AnthropicLLMAdapter({
        apiKey,
        model,
        baseUrl,
        apiVersion,
        ...(maxTokens !== undefined && { maxTokens }),
        ...(temperature !== undefined && { temperature }),
        ...(topP !== undefined && { topP }),
        ...(topK !== undefined && { topK }),
        ...(timeout !== undefined && { timeout }),
        ...(retries !== undefined && { retries }),
        ...(retryDelay !== undefined && { retryDelay }),
        ...(generatePrompt !== undefined && { generatePrompt }),
        ...(summarizePrompt !== undefined && { summarizePrompt }),
      });
    case "ollama":
      return new OllamaLLMAdapter({
        model,
        host,
        ...(temperature !== undefined && { temperature }),
        ...(topP !== undefined && { topP }),
        ...(topK !== undefined && { topK }),
        ...(timeout !== undefined && { timeout }),
        ...(retries !== undefined && { retries }),
        ...(retryDelay !== undefined && { retryDelay }),
        ...(generatePrompt !== undefined && { generatePrompt }),
        ...(summarizePrompt !== undefined && { summarizePrompt }),
      });
    default:
      return null;
  }
}

export { createEmbeddingAdapter, createLLMAdapter };
