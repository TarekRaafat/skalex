export declare abstract class StorageAdapter {
  abstract read(name: string): Promise<string | null>;
  abstract write(name: string, data: string): Promise<void>;
  abstract delete(name: string): Promise<void>;
  abstract list(): Promise<string[]>;
}

export declare class FsAdapter extends StorageAdapter {
  readonly dir: string;
  readonly format: 'gz' | 'json';
  /** @param opts.dir - Directory path for data files. */
  constructor(opts: { dir: string; format?: 'gz' | 'json' });
  read(name: string): Promise<string | null>;
  write(name: string, data: string): Promise<void>;
  writeAll(entries: Array<{ name: string; data: string }>): Promise<void>;
  delete(name: string): Promise<void>;
  list(): Promise<string[]>;
  join(...parts: string[]): string;
  ensureDir(dir: string): void;
  writeRaw(filePath: string, content: string): Promise<void>;
  readRaw(filePath: string): Promise<string>;
  /**
   * Remove orphan temp files (`*.tmp.*`) left by interrupted writes.
   * Returns the number of files removed. Best-effort per-file unlink.
   */
  cleanOrphans(): Promise<number>;
}

export declare class LocalStorageAdapter extends StorageAdapter {
  /** @param opts.namespace - Key prefix to avoid collisions. Default: 'default'. */
  constructor(opts?: { namespace?: string });
  read(name: string): Promise<string | null>;
  write(name: string, data: string): Promise<void>;
  delete(name: string): Promise<void>;
  list(): Promise<string[]>;
}

export declare class EncryptedAdapter extends StorageAdapter {
  /** Wraps any StorageAdapter with AES-256-GCM encryption. */
  constructor(adapter: StorageAdapter, key: string | Uint8Array);
  read(name: string): Promise<string | null>;
  write(name: string, data: string): Promise<void>;
  writeAll(entries: Array<{ name: string; data: string }>): Promise<void>;
  delete(name: string): Promise<void>;
  list(): Promise<string[]>;
  /** Forwarded to the wrapped adapter if supported. */
  cleanOrphans?(): Promise<number>;
}

export declare class D1Adapter extends StorageAdapter {
  /**
   * @param d1 - The D1Database binding from your Cloudflare Worker environment.
   * @param opts.table - Table name. Default: "skalex_store".
   * @param opts.batchSize - Max statements per `d1.batch()` call. Default: 1000
   *   (matching Cloudflare's documented per-batch limit). Values outside
   *   `[1, 1000]` are rejected at construction.
   */
  constructor(d1: object, opts?: { table?: string; batchSize?: number });
  read(name: string): Promise<string | null>;
  write(name: string, data: string): Promise<void>;
  writeAll(entries: Array<{ name: string; data: string }>): Promise<void>;
  delete(name: string): Promise<void>;
  list(): Promise<string[]>;
}

export declare class BunSQLiteAdapter extends StorageAdapter {
  /** @param path - Path to the SQLite file, or ':memory:'. Default: ':memory:'. */
  constructor(path?: string, opts?: { table?: string });
  read(name: string): Promise<string | null>;
  write(name: string, data: string): Promise<void>;
  delete(name: string): Promise<void>;
  list(): Promise<string[]>;
  close(): void;
}

export declare class LibSQLAdapter extends StorageAdapter {
  /** @param client - A @libsql/client Client instance. */
  constructor(client: object, opts?: { table?: string });
  read(name: string): Promise<string | null>;
  write(name: string, data: string): Promise<void>;
  delete(name: string): Promise<void>;
  list(): Promise<string[]>;
}

// --- Embedding Adapters -------------------------------------------------------

export declare abstract class EmbeddingAdapter {
  abstract embed(text: string): Promise<number[]>;
}

export declare class OpenAIEmbeddingAdapter extends EmbeddingAdapter {
  /** @param config.model - Default: 'text-embedding-3-small' (1536 dimensions). */
  constructor(config?: { apiKey?: string; model?: string; baseUrl?: string; dimensions?: number; organization?: string; timeout?: number; retries?: number; retryDelay?: number; headers?: Record<string, string>; fetch?: typeof fetch });
  embed(text: string): Promise<number[]>;
}

export declare class OllamaEmbeddingAdapter extends EmbeddingAdapter {
  /** @param config.model - Default: 'nomic-embed-text' (768 dimensions). */
  constructor(config?: { model?: string; host?: string; timeout?: number; retries?: number; retryDelay?: number; headers?: Record<string, string>; fetch?: typeof fetch });
  embed(text: string): Promise<number[]>;
}

// --- Language Model Adapters --------------------------------------------------

export declare abstract class LLMAdapter {
  abstract generate(schema: Record<string, string> | null, nlQuery: string): Promise<Record<string, unknown>>;
  abstract summarize(texts: string): Promise<string>;
}

export declare class OpenAILLMAdapter extends LLMAdapter {
  /** @param config.model - Default: 'gpt-4o-mini'. @param config.temperature - Default: 0.3. */
  constructor(config?: { apiKey?: string; model?: string; baseUrl?: string; maxTokens?: number; temperature?: number; topP?: number; organization?: string; timeout?: number; retries?: number; retryDelay?: number; headers?: Record<string, string>; fetch?: typeof fetch; seed?: number; generatePrompt?: string; summarizePrompt?: string });
  generate(schema: Record<string, string> | null, nlQuery: string): Promise<Record<string, unknown>>;
  summarize(texts: string): Promise<string>;
}

export declare class AnthropicLLMAdapter extends LLMAdapter {
  /** @param config.model - Default: 'claude-haiku-4-5'. @param config.maxTokens - Default: 1024. @param config.temperature - Default: 0.3. */
  constructor(config?: { apiKey?: string; model?: string; baseUrl?: string; apiVersion?: string; maxTokens?: number; temperature?: number; topP?: number; topK?: number; timeout?: number; retries?: number; retryDelay?: number; headers?: Record<string, string>; fetch?: typeof fetch; generatePrompt?: string; summarizePrompt?: string });
  generate(schema: Record<string, string> | null, nlQuery: string): Promise<Record<string, unknown>>;
  summarize(texts: string): Promise<string>;
}

export declare class OllamaLLMAdapter extends LLMAdapter {
  /** @param config.model - Default: 'llama3.2'. @param config.temperature - Default: 0.3. */
  constructor(config?: { model?: string; host?: string; temperature?: number; topP?: number; topK?: number; timeout?: number; retries?: number; retryDelay?: number; headers?: Record<string, string>; fetch?: typeof fetch; generatePrompt?: string; summarizePrompt?: string });
  generate(schema: Record<string, string> | null, nlQuery: string): Promise<Record<string, unknown>>;
  summarize(texts: string): Promise<string>;
}
