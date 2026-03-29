// ─── Skalex v4 TypeScript Definitions ────────────────────────────────────────

// ─── Config ──────────────────────────────────────────────────────────────────

export interface AIConfig {
  /** AI provider. */
  provider: 'openai' | 'anthropic' | 'ollama';
  /** API key (required for OpenAI and Anthropic). */
  apiKey?: string;
  /** Embedding model override (falls back to `model`). */
  embedModel?: string;
  /** Language model override. Required for db.ask() and memory.compress(). */
  model?: string;
  /** Ollama server URL. Default: 'http://localhost:11434'. */
  host?: string;
}

export interface EncryptConfig {
  /** AES-256 key: 64-character hex string or 32-byte Uint8Array. */
  key: string | Uint8Array;
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
  /** AI / embedding configuration. Required for vector search and db.ask(). */
  ai?: AIConfig;
  /** At-rest encryption configuration. Wraps the storage adapter with AES-256-GCM. */
  encrypt?: EncryptConfig;
}

// ─── Adapters ────────────────────────────────────────────────────────────────

export declare abstract class EmbeddingAdapter {
  abstract embed(text: string): Promise<number[]>;
}

export declare abstract class AIAdapter {
  abstract generate(schema: Record<string, string> | null, nlQuery: string): Promise<Record<string, unknown>>;
  abstract summarize(texts: string): Promise<string>;
}

export declare class EncryptedAdapter extends StorageAdapter {
  constructor(adapter: StorageAdapter, key: string | Uint8Array);
  read(name: string): Promise<string | null>;
  write(name: string, data: string): Promise<void>;
  delete(name: string): Promise<void>;
  list(): Promise<string[]>;
}

// ─── Storage ─────────────────────────────────────────────────────────────────

export declare abstract class StorageAdapter {
  abstract read(name: string): Promise<string | null>;
  abstract write(name: string, data: string): Promise<void>;
  abstract delete(name: string): Promise<void>;
  abstract list(): Promise<string[]>;
}

// ─── Schema ──────────────────────────────────────────────────────────────────

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
}

// ─── Query operators ─────────────────────────────────────────────────────────

export interface QueryOperators<T = unknown> {
  $eq?: T;
  $ne?: T;
  $gt?: T;
  $gte?: T;
  $lt?: T;
  $lte?: T;
  $in?: T[];
  $nin?: T[];
  $regex?: RegExp;
  $fn?: (value: T) => boolean;
}

export type FilterValue<T = unknown> = T | RegExp | QueryOperators<T>;
export type Filter<T = Record<string, unknown>> =
  | { [K in keyof T]?: FilterValue<T[K]> }
  | ((doc: T) => boolean)
  | Record<string, FilterValue>;

// ─── Operation options ────────────────────────────────────────────────────────

export interface InsertOneOptions {
  save?: boolean;
  /** Return the existing document instead of inserting if a match is found. */
  ifNotExists?: boolean;
  /** Set a TTL: number (seconds), '30m', '24h', '7d', etc. */
  ttl?: number | string;
  /** Field name (or selector function) whose value is embedded and stored as _vector. */
  embed?: string | ((doc: Record<string, unknown>) => string);
}

export interface InsertManyOptions {
  save?: boolean;
  ttl?: number | string;
  /** Field name (or selector function) whose value is embedded and stored as _vector. */
  embed?: string | ((doc: Record<string, unknown>) => string);
}

export interface UpdateOptions {
  save?: boolean;
}

export interface DeleteOptions {
  save?: boolean;
}

export interface FindOptions {
  populate?: string[];
  select?: string[];
  /** Sort descriptor: 1 = ascending, -1 = descending. */
  sort?: Record<string, 1 | -1>;
  page?: number;
  limit?: number;
}

export interface ExportOptions {
  dir?: string;
  name?: string;
  format?: 'json' | 'csv';
}

// ─── Return shapes ────────────────────────────────────────────────────────────

export interface Document {
  _id: string;
  createdAt: Date;
  updatedAt: Date;
  _expiresAt?: Date;
  [key: string]: unknown;
}

export type DocOf<T> = T & Document;

export interface SingleResult<T = Document> {
  data: T;
}

export interface ManyResult<T = Document> {
  docs: T[];
}

export interface FindResult<T = Document> {
  docs: T[];
  page?: number;
  totalDocs?: number;
  totalPages?: number;
}

export interface SearchOptions<T = Record<string, unknown>> {
  /** Structured pre-filter applied before scoring (hybrid search). */
  filter?: Filter<T>;
  /** Maximum number of results. Default: 10. */
  limit?: number;
  /** Minimum cosine similarity score [0, 1]. Default: 0. */
  minScore?: number;
}

export interface SearchResult<T = Document> {
  docs: T[];
  /** Cosine similarity scores, parallel to docs[]. */
  scores: number[];
}

// ─── Migration ───────────────────────────────────────────────────────────────

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

// ─── Collection ───────────────────────────────────────────────────────────────

export declare class Collection<T extends Record<string, unknown> = Record<string, unknown>> {
  readonly name: string;

  // Insert
  insertOne(item: Partial<T>, options?: InsertOneOptions): Promise<SingleResult<DocOf<T>>>;
  insertMany(items: Partial<T>[], options?: InsertManyOptions): Promise<ManyResult<DocOf<T>>>;

  // Find
  findOne(filter: Filter<T>, options?: FindOptions): Promise<DocOf<T> | null>;
  find(filter: Filter<T>, options?: FindOptions): Promise<FindResult<DocOf<T>>>;

  // Update
  updateOne(filter: Filter<T>, update: Record<string, unknown>, options?: UpdateOptions): Promise<SingleResult<DocOf<T>> | null>;
  updateMany(filter: Filter<T>, update: Record<string, unknown>, options?: UpdateOptions): Promise<ManyResult<DocOf<T>>>;

  // Upsert
  upsert(filter: Filter<T>, doc: Partial<T>, options?: UpdateOptions): Promise<SingleResult<DocOf<T>>>;

  // Delete
  deleteOne(filter: Filter<T>, options?: DeleteOptions): Promise<SingleResult<DocOf<T>> | null>;
  deleteMany(filter: Filter<T>, options?: DeleteOptions): Promise<ManyResult<DocOf<T>>>;

  // Vector search
  search(query: string, options?: SearchOptions<T>): Promise<SearchResult<DocOf<T>>>;
  similar(id: string, options?: { limit?: number; minScore?: number }): Promise<SearchResult<DocOf<T>>>;

  // I/O
  export(filter?: Filter<T>, options?: ExportOptions): Promise<void>;
}

// ─── Memory ───────────────────────────────────────────────────────────────────

export declare class Memory {
  readonly sessionId: string;
  constructor(sessionId: string, db: Skalex);

  remember(text: string): Promise<SingleResult<Document>>;
  recall(query: string, options?: { limit?: number; minScore?: number }): Promise<SearchResult<Document>>;
  history(options?: { since?: string | Date; limit?: number }): Promise<Document[]>;
  forget(id: string): Promise<SingleResult<Document> | null>;
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
  constructor(db: Skalex);
  log(op: 'insert' | 'update' | 'delete', collection: string, doc: Document, prev?: Document | null, session?: string | null): Promise<void>;
  query(collection: string, options?: ChangeLogQueryOptions): Promise<ChangeLogEntry[]>;
  restore(collection: string, timestamp: string | Date, options?: { _id?: string }): Promise<void>;
}

// ─── CollectionInfo ───────────────────────────────────────────────────────────

export interface CollectionInfo {
  name: string;
  count: number;
  schema: Record<string, unknown> | null;
  indexes: string[];
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
  import(filePath: string, format?: 'json' | 'csv'): Promise<ManyResult>;

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
}

export default Skalex;
