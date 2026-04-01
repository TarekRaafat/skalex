/**
 * Full connectors barrel  -  all adapter types in one import.
 *
 * import { FsAdapter, LocalStorageAdapter, EncryptedAdapter,
 *           OpenAIEmbeddingAdapter, OllamaEmbeddingAdapter,
 *           OpenAILLMAdapter, AnthropicLLMAdapter, OllamaLLMAdapter } from 'skalex/connectors';
 *
 * Tree-shaking removes any adapters not referenced in your code.
 * Platform-specific adapters (BunSQLiteAdapter, D1Adapter, LibSQLAdapter) access
 * their platform APIs lazily  -  no static import errors in other environments.
 *
 * For scoped imports use the sub-barrel paths:
 *   skalex/connectors/storage    -  storage adapters only
 *   skalex/connectors/embedding  -  embedding adapters only
 *   skalex/connectors/llm        -  LLM adapters only
 */

// Storage
export { default as FsAdapter }           from "./storage/fs.js";
export { default as LocalStorageAdapter } from "./storage/local.js";
export { default as EncryptedAdapter }    from "./storage/encrypted.js";
export { default as BunSQLiteAdapter }    from "./storage/bun-sqlite.js";
export { default as D1Adapter }           from "./storage/d1.js";
export { default as LibSQLAdapter }       from "./storage/libsql.js";

// Embedding
export { default as OpenAIEmbeddingAdapter } from "./embedding/openai.js";
export { default as OllamaEmbeddingAdapter } from "./embedding/ollama.js";

// LLM
export { default as OpenAILLMAdapter }    from "./llm/openai.js";
export { default as AnthropicLLMAdapter } from "./llm/anthropic.js";
export { default as OllamaLLMAdapter }    from "./llm/ollama.js";
