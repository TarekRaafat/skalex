// ─── Skalex v4 TypeScript Definitions ────────────────────────────────────────

// ─── Config ──────────────────────────────────────────────────────────────────

export interface AIConfig {
  /** AI provider. */
  provider: 'openai' | 'anthropic' | 'ollama';
  /** API key (required for OpenAI and Anthropic). Falls back to OPENAI_API_KEY / ANTHROPIC_API_KEY env var. */
  apiKey?: string;
  /** Language model. Required for db.ask() and memory.compress(). Falls back to OPENAI_MODEL / ANTHROPIC_MODEL / OLLAMA_MODEL env var. */
  model?: string;
  /** Embedding model override. Falls back to provider default if omitted. Falls back to OPENAI_EMBED_MODEL / OLLAMA_EMBED_MODEL env var. */
  embedModel?: string;
  /** Ollama server URL. Default: 'http://localhost:11434'. Falls back to OLLAMA_HOST env var. */
  host?: string;
  /** LLM endpoint URL override. Useful for proxies or OpenAI-compatible APIs. Falls back to OPENAI_BASE_URL / ANTHROPIC_BASE_URL env var. */
  baseUrl?: string;
  /** Embedding endpoint URL override. Falls back to OPENAI_EMBED_BASE_URL env var. (OpenAI only) */
  embedBaseUrl?: string;
  /** Anthropic-Version header. Default: '2023-06-01'. (Anthropic only) */
  apiVersion?: string;
  /** Sampling temperature for summarize(). Default: 0.3. generate() always uses 0. Falls back to provider TEMPERATURE env var. */
  temperature?: number;
  /** Maximum tokens for LLM responses. Default: 1024 (Anthropic). Falls back to provider MAX_TOKENS env var. */
  maxTokens?: number;
  /** Nucleus sampling for summarize(). Falls back to provider TOP_P env var. (OpenAI, Anthropic, Ollama) */
  topP?: number;
  /** Top-K sampling for summarize(). Falls back to provider TOP_K env var. (Anthropic, Ollama only) */
  topK?: number;
  /** OpenAI organization ID. Falls back to OPENAI_ORGANIZATION env var. (OpenAI only) */
  organization?: string;
  /** LLM request timeout in ms. Falls back to provider TIMEOUT env var. */
  timeout?: number;
  /** Output vector dimensions (text-embedding-3-* only). Falls back to OPENAI_EMBED_DIMENSIONS env var. (OpenAI only) */
  dimensions?: number;
  /** Embedding request timeout in ms. Falls back to provider EMBED_TIMEOUT env var. */
  embedTimeout?: number;
  /** LLM retry attempts on failure. Default: 0. Falls back to provider RETRIES env var. */
  retries?: number;
  /** LLM base retry delay in ms (doubles each attempt). Default: 1000. Falls back to provider RETRY_DELAY env var. */
  retryDelay?: number;
  /** Embedding retry attempts on failure. Default: 0. Falls back to provider EMBED_RETRIES env var. */
  embedRetries?: number;
  /** Embedding base retry delay in ms (doubles each attempt). Default: 1000. Falls back to provider EMBED_RETRY_DELAY env var. */
  embedRetryDelay?: number;
  /** Seed for deterministic outputs. Falls back to OPENAI_SEED env var. (OpenAI only) */
  seed?: number;
  /** Custom system prompt for generate(). Schema is always appended. Defaults to built-in query-assistant prompt. */
  generatePrompt?: string;
  /** Custom system prompt for summarize(). Defaults to built-in summarization prompt. */
  summarizePrompt?: string;
}

export interface QueryCacheConfig {
  /** Maximum number of cached entries. Oldest is evicted when full. Default: 500. */
  maxSize?: number;
  /** Cache TTL in ms. 0 = no expiry. Default: 0. */
  ttl?: number;
}

export interface MemoryConfig {
  /** Token threshold that triggers auto-compression. Default: 8000. */
  compressionThreshold?: number;
  /** Maximum memory entries before auto-compress is triggered. Default: none. */
  maxEntries?: number;
  /** Number of recent entries preserved during compress(). Default: 10. */
  keepRecent?: number;
  /** Default token budget for context(). Default: 4000. */
  contextTokens?: number;
}

export interface EncryptConfig {
  /** AES-256 key: 64-character hex string or 32-byte Uint8Array. */
  key: string | Uint8Array;
}

export interface SlowQueryLogConfig {
  /** Duration threshold in ms. Queries longer than this are recorded. Default: 100. */
  threshold?: number;
  /** Maximum number of entries to keep in the ring buffer. Default: 500. */
  maxEntries?: number;
}

export interface MCPScopes {
  [collection: string]: Array<'read' | 'write' | 'admin'>;
}

export interface MCPOptions {
  /** Transport type. Default: 'stdio'. */
  transport?: 'stdio' | 'http';
  /** HTTP port (http transport only). Default: 3000. */
  port?: number;
  /** HTTP host (http transport only). Default: '127.0.0.1'. */
  host?: string;
  /** Access control map. Default: { '*': ['read'] } (read-only). */
  scopes?: MCPScopes;
  /** CORS origin for HTTP transport. Disabled by default. */
  allowedOrigin?: string;
  /** Maximum POST body size in bytes for HTTP transport. Default: 1 MiB (1_048_576). */
  maxBodySize?: number;
}

export interface SkalexConfig {
  /** Path to the data directory. Default: './.db' */
  path?: string;
  /** Storage format. Default: 'gz' */
  format?: 'gz' | 'json';
  /** Enable debug logging. Default: false */
  debug?: boolean;
  /** Custom storage adapter (overrides FsAdapter). */
  adapter?: StorageAdapter;
  /** AI and embedding configuration. Required for vector search and db.ask(). */
  ai?: AIConfig;
  /** At-rest encryption. Wraps the storage adapter with AES-256-GCM. */
  encrypt?: EncryptConfig;
  /** Enable slow query logging. */
  slowQueryLog?: SlowQueryLogConfig;
  /** Query cache options. */
  queryCache?: QueryCacheConfig;
  /** Global agent memory options. */
  memory?: MemoryConfig;
  /** Custom logger function. Receives (message: string, level: 'info' | 'error'). */
  logger?: (message: string, level: 'info' | 'error') => void;
  /** Pre-built LLM adapter instance. Overrides ai.model factory. */
  llmAdapter?: LLMAdapter;
  /** Pre-built embedding adapter instance. Overrides ai.provider embedding factory. */
  embeddingAdapter?: EmbeddingAdapter;
  /** Maximum $regex pattern length in ask() filters. Default: 500. */
  regexMaxLength?: number;
  /** Custom document ID generator. Default: built-in timestamp+random. */
  idGenerator?: () => string;
  /** Custom serializer for storage writes. Default: JSON.stringify. */
  serializer?: (data: unknown) => string;
  /** Custom deserializer for storage reads. Default: JSON.parse. */
  deserializer?: (raw: string) => unknown;
  /** Pre-register plugins on construction. */
  plugins?: Plugin[];
  /** Automatically persist after every write without passing { save: true }. Default: false. */
  autoSave?: boolean;
  /** Interval in ms to run a periodic TTL sweep. Disabled when omitted. */
  ttlSweepInterval?: number;
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export interface PluginInsertContext  { collection: string; doc: Record<string, unknown>; }
export interface PluginUpdateContext  { collection: string; filter: object; update: object; result?: Record<string, unknown> | Record<string, unknown>[]; }
export interface PluginDeleteContext  { collection: string; filter: object; result?: Record<string, unknown> | Record<string, unknown>[]; }
export interface PluginFindContext    { collection: string; filter: object; options: object; docs?: Record<string, unknown>[]; }
export interface PluginSearchContext  { collection: string; query: string; options: object; docs?: Record<string, unknown>[]; scores?: number[]; }

export interface Plugin {
  beforeInsert?(ctx: PluginInsertContext): void | Promise<void>;
  afterInsert?(ctx: PluginInsertContext):  void | Promise<void>;
  beforeUpdate?(ctx: PluginUpdateContext): void | Promise<void>;
  afterUpdate?(ctx: PluginUpdateContext):  void | Promise<void>;
  beforeDelete?(ctx: PluginDeleteContext): void | Promise<void>;
  afterDelete?(ctx: PluginDeleteContext):  void | Promise<void>;
  beforeFind?(ctx: PluginFindContext):     void | Promise<void>;
  afterFind?(ctx: PluginFindContext):      void | Promise<void>;
  beforeSearch?(ctx: PluginSearchContext): void | Promise<void>;
  afterSearch?(ctx: PluginSearchContext):  void | Promise<void>;
}

// ─── Session Stats ────────────────────────────────────────────────────────────

export interface SessionEntry {
  sessionId: string;
  reads: number;
  writes: number;
  lastActive: Date | null;
}

// ─── Storage Adapters ────────────────────────────────────────────────────────

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
  delete(name: string): Promise<void>;
  list(): Promise<string[]>;
  join(...parts: string[]): string;
  ensureDir(dir: string): void;
  writeRaw(filePath: string, content: string): Promise<void>;
  readRaw(filePath: string): Promise<string>;
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
  delete(name: string): Promise<void>;
  list(): Promise<string[]>;
}

export declare class D1Adapter extends StorageAdapter {
  /** @param d1 - The D1Database binding from your Cloudflare Worker environment. */
  constructor(d1: object, opts?: { table?: string });
  read(name: string): Promise<string | null>;
  write(name: string, data: string): Promise<void>;
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

// ─── Embedding Adapters ───────────────────────────────────────────────────────

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

// ─── Language Model Adapters ──────────────────────────────────────────────────

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

// ─── Schema ───────────────────────────────────────────────────────────────────

export type FieldType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'date' | 'any';

export interface FieldDefinition {
  type?: FieldType;
  required?: boolean;
  unique?: boolean;
  enum?: unknown[];
}

export type SchemaDefinition = Record<string, FieldType | FieldDefinition>;

export interface CollectionOptions {
  schema?: SchemaDefinition;
  /** Fields to build secondary (non-unique) indexes on. */
  indexes?: string[];
  /** Enable append-only mutation log for this collection. */
  changelog?: boolean;
  /** Mark deleted documents instead of removing them. Use col.restore() to undo. */
  softDelete?: boolean;
  /** Auto-increment _version on every update. Starts at 1 on insert. */
  versioning?: boolean;
  /** Reject unknown fields not declared in the schema. */
  strict?: boolean;
  /** How to handle schema validation errors. Default: 'throw'. */
  onSchemaError?: 'throw' | 'warn' | 'strip';
  /** Default TTL applied to every inserted document (seconds or shorthand like '24h'). */
  defaultTtl?: number | string;
  /** Field name embedded as _vector on every inserted document. */
  defaultEmbed?: string;
  /** Maximum number of documents. Oldest (FIFO) are evicted when exceeded. */
  maxDocs?: number;
}

// ─── Mutation Event ───────────────────────────────────────────────────────────

export interface MutationEvent<T = Document> {
  op: 'insert' | 'update' | 'delete' | 'restore';
  collection: string;
  doc: T;
  prev?: T;
}

// ─── Query Operators ─────────────────────────────────────────────────────────

export interface QueryOperators<T = unknown> {
  $eq?: T;
  $ne?: T;
  $gt?: T;
  $gte?: T;
  $lt?: T;
  $lte?: T;
  $in?: T[];
  $nin?: T[];
  /** Regex pattern string. Max 500 characters. */
  $regex?: string;
  $fn?: (value: T) => boolean;
}

export type FilterValue<T = unknown> = T | RegExp | QueryOperators<T>;
export type Filter<T = Record<string, unknown>> =
  | { [K in keyof T]?: FilterValue<T[K]> }
  | ((doc: T) => boolean)
  | Record<string, FilterValue>;

// ─── Update Operators ─────────────────────────────────────────────────────────

export interface UpdateOperators {
  /** Increment a numeric field by the given amount. */
  $inc?: number;
  /** Append a value to an array field. */
  $push?: unknown;
}

export type UpdateDescriptor<T = Record<string, unknown>> =
  { [K in keyof T]?: T[K] | UpdateOperators } & Record<string, unknown | UpdateOperators>;

// ─── Operation Options ────────────────────────────────────────────────────────

export interface InsertOneOptions {
  save?: boolean;
  /** Return the existing document instead of inserting when a match is found. */
  ifNotExists?: boolean;
  /** Set a TTL: number of seconds, '30m', '24h', '7d', etc. */
  ttl?: number | string;
  /** Field name or selector function whose value is embedded as _vector. */
  embed?: string | ((doc: Record<string, unknown>) => string);
  /** Session identifier for audit trail and stats tracking. */
  session?: string;
}

export interface InsertManyOptions {
  save?: boolean;
  ttl?: number | string;
  /** Field name or selector function whose value is embedded as _vector. */
  embed?: string | ((doc: Record<string, unknown>) => string);
  /** Session identifier for audit trail and stats tracking. */
  session?: string;
}

export interface UpdateOptions {
  save?: boolean;
  /** Session identifier for audit trail and stats tracking. */
  session?: string;
}

export interface DeleteOptions {
  save?: boolean;
  /** Session identifier for audit trail and stats tracking. */
  session?: string;
}

export interface FindOptions {
  populate?: string[];
  select?: string[];
  /** Sort descriptor: 1 = ascending, -1 = descending. */
  sort?: Record<string, 1 | -1>;
  page?: number;
  limit?: number;
  /** Session identifier for per-session stats tracking. */
  session?: string;
  /** Include soft-deleted documents in results. Default: false. */
  includeDeleted?: boolean;
}

export interface ExportOptions {
  dir?: string;
  name?: string;
  format?: 'json' | 'csv';
}

// ─── Return Shapes ────────────────────────────────────────────────────────────

export interface Document {
  _id: string;
  createdAt: Date;
  updatedAt: Date;
  _expiresAt?: Date;
  [key: string]: unknown;
}

export type DocOf<T> = T & Document;

export interface FindResult<T = Document> {
  docs: T[];
  page?: number;
  totalDocs?: number;
  totalPages?: number;
}

export interface SearchOptions<T = Record<string, unknown>> {
  /** Structured pre-filter applied before cosine scoring (hybrid search). */
  filter?: Filter<T>;
  /** Maximum number of results. Default: 10. */
  limit?: number;
  /** Minimum cosine similarity score [-1, 1]. Default: 0. */
  minScore?: number;
  /** Session identifier for per-session stats tracking. */
  session?: string;
}

export interface SearchResult<T = Document> {
  docs: T[];
  /** Cosine similarity scores, parallel to docs[]. */
  scores: number[];
}

// ─── Migration ────────────────────────────────────────────────────────────────

export interface Migration {
  version: number;
  description?: string;
  up: (collection: Collection) => Promise<void>;
}

export interface MigrationStatus {
  current: number;
  applied: number[];
  pending: number[];
}

// ─── Stats ────────────────────────────────────────────────────────────────────

export interface CollectionStats {
  collection: string;
  count: number;
  estimatedSize: number;
  avgDocSize: number;
}

export interface CollectionInfo {
  name: string;
  count: number;
  schema: Record<string, unknown> | null;
  indexes: string[];
  softDelete: boolean;
  versioning: boolean;
  strict: boolean;
  onSchemaError: 'throw' | 'warn' | 'strip';
  maxDocs: number | null;
}

export interface SlowQueryEntry {
  collection: string;
  op: string;
  filter?: object;
  query?: string;
  duration: number;
  resultCount: number;
  timestamp: Date;
}

// ─── Collection ───────────────────────────────────────────────────────────────

export interface UpsertManyOptions extends InsertManyOptions {
  save?: boolean;
}

export declare class Collection<T extends Record<string, unknown> = Record<string, unknown>> {
  readonly name: string;

  // Insert
  insertOne(item: Partial<T>, options?: InsertOneOptions): Promise<DocOf<T>>;
  insertMany(items: Partial<T>[], options?: InsertManyOptions): Promise<DocOf<T>[]>;

  // Find
  findOne(filter: Filter<T>, options?: FindOptions): Promise<DocOf<T> | null>;
  find(filter?: Filter<T>, options?: FindOptions): Promise<FindResult<DocOf<T>>>;

  // Update
  updateOne(filter: Filter<T>, update: UpdateDescriptor<T>, options?: UpdateOptions): Promise<DocOf<T> | null>;
  updateMany(filter: Filter<T>, update: UpdateDescriptor<T>, options?: UpdateOptions): Promise<DocOf<T>[]>;

  // Upsert
  upsert(filter: Filter<T>, doc: Partial<T>, options?: UpdateOptions): Promise<DocOf<T>>;
  /** Batch upsert: match each doc on matchKey, update if found, insert otherwise. */
  upsertMany(docs: Partial<T>[], matchKey: keyof T & string, options?: UpsertManyOptions): Promise<DocOf<T>[]>;

  // Delete
  deleteOne(filter: Filter<T>, options?: DeleteOptions): Promise<DocOf<T> | null>;
  deleteMany(filter: Filter<T>, options?: DeleteOptions): Promise<DocOf<T>[]>;

  // Soft-delete restore (requires softDelete: true on the collection)
  restore(filter: Filter<T>, options?: { save?: boolean; session?: string }): Promise<DocOf<T> | null>;

  // Vector search
  search(query: string, options?: SearchOptions<T>): Promise<SearchResult<DocOf<T>>>;
  similar(id: string, options?: { limit?: number; minScore?: number }): Promise<SearchResult<DocOf<T>>>;

  // Aggregation
  count(filter?: Filter<T>): Promise<number>;
  sum(field: string, filter?: Filter<T>): Promise<number>;
  avg(field: string, filter?: Filter<T>): Promise<number | null>;
  groupBy(field: string, filter?: Filter<T>): Promise<Record<string, DocOf<T>[]>>;

  // Watch — callback form
  watch(callback: (event: MutationEvent<DocOf<T>>) => void): () => void;
  watch(filter: Filter<T>, callback: (event: MutationEvent<DocOf<T>>) => void): () => void;
  // Watch — AsyncIterableIterator form
  watch(filter?: Filter<T>): AsyncIterableIterator<MutationEvent<DocOf<T>>>;

  // I/O
  export(filter?: Filter<T>, options?: ExportOptions): Promise<void>;
}

// ─── Memory ───────────────────────────────────────────────────────────────────

export declare class Memory {
  readonly sessionId: string;
  private constructor(sessionId: string, db: Skalex);

  remember(text: string): Promise<Document>;
  recall(query: string, options?: { limit?: number; minScore?: number }): Promise<SearchResult<Document>>;
  history(options?: { since?: string | Date; limit?: number }): Promise<Document[]>;
  forget(id: string): Promise<Document | null>;
  tokenCount(): { tokens: number; count: number };
  context(options?: { tokens?: number }): string;
  compress(options?: { threshold?: number }): Promise<void>;
}

// ─── ChangeLog ────────────────────────────────────────────────────────────────

export interface ChangeLogEntry {
  _id: string;
  op: 'insert' | 'update' | 'delete';
  collection: string;
  docId: string;
  doc: Document;
  prev?: Document;
  timestamp: Date;
  session?: string;
}

export interface ChangeLogQueryOptions {
  since?: string | Date;
  limit?: number;
  session?: string;
}

export declare class ChangeLog {
  private constructor(db: Skalex);
  log(op: 'insert' | 'update' | 'delete', collection: string, doc: Document, prev?: Document | null, session?: string | null): Promise<void>;
  query(collection: string, options?: ChangeLogQueryOptions): Promise<ChangeLogEntry[]>;
  restore(collection: string, timestamp: string | Date, options?: { _id?: string }): Promise<void>;
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

export declare class SkalexMCPServer {
  private constructor(db: Skalex, options?: MCPOptions);
  readonly transport: 'stdio' | 'http';
  readonly url: string | undefined;
  /** Start listening on the configured transport. */
  listen(): Promise<void>;
  /** Connect a custom transport (for testing). */
  connect(transport: object): Promise<void>;
  /** Stop the server. */
  close(): Promise<void>;
}

// ─── Skalex ───────────────────────────────────────────────────────────────────

export declare class Skalex {
  constructor(config?: SkalexConfig);

  readonly dataDirectory: string;
  readonly dataFormat: string;
  readonly isConnected: boolean;
  readonly debug: boolean;

  // Connection
  connect(): Promise<void>;
  disconnect(): Promise<void>;

  // Collections
  useCollection<T extends Record<string, unknown> = Record<string, unknown>>(name: string): Collection<T>;
  createCollection<T extends Record<string, unknown> = Record<string, unknown>>(name: string, options?: CollectionOptions): Collection<T>;
  renameCollection(from: string, to: string): Promise<void>;

  // Persistence
  saveData(collectionName?: string): Promise<void>;
  loadData(): Promise<void>;

  // Migrations
  addMigration(migration: Migration): void;
  migrationStatus(): MigrationStatus;

  // Namespace
  namespace(id: string): Skalex;

  // Transaction
  transaction<R = unknown>(fn: (db: Skalex) => Promise<R>): Promise<R>;

  // Seeding
  seed(fixtures: Record<string, Record<string, unknown>[]>, options?: { reset?: boolean }): Promise<void>;

  // Introspection
  dump(): Record<string, Document[]>;
  inspect(collectionName: string): CollectionInfo | null;
  inspect(): Record<string, CollectionInfo>;

  // Import
  import(filePath: string): Promise<Document[]>;

  // Embedding
  embed(text: string): Promise<number[]>;

  // AI Query
  ask(collectionName: string, nlQuery: string, options?: { limit?: number }): Promise<FindResult<Document>>;

  // Schema introspection
  schema(collectionName: string): Record<string, string> | null;

  // Agent Memory
  useMemory(sessionId: string): Memory;

  // ChangeLog
  changelog(): ChangeLog;
  restore(collectionName: string, timestamp: string | Date, options?: { _id?: string }): Promise<void>;

  // Stats
  stats(collectionName: string): CollectionStats | null;
  stats(): CollectionStats[];

  // Slow query log
  slowQueries(options?: { limit?: number; minDuration?: number; collection?: string }): SlowQueryEntry[];
  slowQueryCount(): number;
  clearSlowQueries(): void;

  // MCP Server
  mcp(options?: MCPOptions): SkalexMCPServer;

  // Plugins
  use(plugin: Plugin): void;

  // Global watch — fires for mutations across all collections
  watch(callback: (event: MutationEvent) => void): () => void;

  // Session Stats
  sessionStats(sessionId: string): SessionEntry | null;
  sessionStats(): SessionEntry[];
}

export default Skalex;
