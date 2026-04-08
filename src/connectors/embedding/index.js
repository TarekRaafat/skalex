/**
 * Embedding connectors barrel.
 *
 * import { OpenAIEmbeddingAdapter, OllamaEmbeddingAdapter } from 'skalex/connectors/embedding';
 */
export { default as EmbeddingAdapter }       from "./base.js";
export { default as OpenAIEmbeddingAdapter } from "./openai.js";
export { default as OllamaEmbeddingAdapter } from "./ollama.js";
