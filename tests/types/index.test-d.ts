/**
 * tsd smoke tests for the public Skalex type declarations.
 *
 * These files are compiled by `tsd` (not vitest). They assert type shape at
 * compile time - a mismatch between runtime and declaration causes
 * `npm run types:check` to fail.
 *
 * Scope: every class and interface exported from `dist/skalex.d.ts`.
 */
import { expectType, expectAssignable, expectError } from "tsd";
import Skalex, {
  Collection,
  Memory,
  Migration,
  MigrationStatus,
  TransactionOptions,
  SkalexConfig,
  Plugin,
  PluginInsertContext,
  PluginUpdateContext,
  StorageAdapter,
  FsAdapter,
  LocalStorageAdapter,
  EncryptedAdapter,
  D1Adapter,
  BunSQLiteAdapter,
  LibSQLAdapter,
  OpenAIEmbeddingAdapter,
  OllamaEmbeddingAdapter,
  OpenAILLMAdapter,
  AnthropicLLMAdapter,
  OllamaLLMAdapter,
  SkalexMCPServer,
  ChangeLog,
  ChangeLogEntry,
  Document,
  FindResult,
  SearchResult,
  SearchOptions,
  CollectionStats,
  CollectionInfo,
  SkalexError,
  ValidationError,
  UniqueConstraintError,
  TransactionError,
  PersistenceError,
  AdapterError,
  QueryError,
} from "../../dist/skalex.js";

// ─── Construction ──────────────────────────────────────────────────────────

const db = new Skalex();
expectType<Promise<void>>(db.connect());
expectType<Promise<void>>(db.disconnect());
expectType<Promise<void>>(db.saveData());
expectType<boolean>(db.isConnected);

// SkalexConfig accepts all documented options.
expectAssignable<SkalexConfig>({
  path: "./db",
  format: "gz",
  debug: true,
  autoSave: true,
  deferredEffectErrors: "throw",
  lenientLoad: true,
  regexMaxLength: 500,
  ttlSweepInterval: 1000,
});

// ─── Collections (untyped) ─────────────────────────────────────────────────

const users = db.useCollection("users");
expectAssignable<Collection>(users);

expectAssignable<Promise<Record<string, unknown>>>(users.insertOne({ name: "Alice" }));
expectAssignable<Promise<Record<string, unknown>[]>>(
  users.insertMany([{ name: "A" }, { name: "B" }])
);
expectAssignable<Promise<Record<string, unknown> | null>>(
  users.findOne({ name: "Alice" })
);
expectAssignable<Promise<Record<string, unknown> | null>>(
  users.updateOne({ _id: "x" }, { name: "Bob" })
);
expectAssignable<Promise<Record<string, unknown> | null>>(users.deleteOne({ _id: "x" }));

users.find({}).then((r) => {
  expectAssignable<Record<string, unknown>[]>(r.docs);
});

expectType<Promise<number>>(users.count());

// ─── Collections (generic) ────────────────────────────────────────────────

interface User extends Record<string, unknown> {
  name: string;
  age: number;
}
const typedUsers = db.useCollection<User>("users");
expectAssignable<Collection<User>>(typedUsers);
// find<T>() returns FindResult whose docs carry the user-typed shape.
typedUsers.find({}).then((r) => {
  expectAssignable<FindResult<User & Document>>(r);
});

// ─── Transactions ──────────────────────────────────────────────────────────

const txOpts: TransactionOptions = {
  timeout: 5000,
  deferredEffectErrors: "throw",
};
expectAssignable<TransactionOptions>({ timeout: 1000 });
expectAssignable<TransactionOptions>({});
expectAssignable<TransactionOptions>({ deferredEffectErrors: "warn" });
expectAssignable<TransactionOptions>({ deferredEffectErrors: "ignore" });

db.transaction(async () => {}, txOpts);
db.transaction(async () => {});
db.transaction<string>(async () => "ok").then((v) => {
  expectType<string>(v);
});

// ─── Memory ────────────────────────────────────────────────────────────────

function checkMemory(mem: Memory) {
  expectType<Promise<{ tokens: number; count: number }>>(mem.tokenCount());
  expectType<Promise<string>>(mem.context());
  expectType<Promise<string>>(mem.context({ tokens: 1000 }));
  expectType<Promise<void>>(mem.compress());
}

// ─── Migration signature ───────────────────────────────────────────────────

const migration: Migration = {
  version: 1,
  description: "seed admin",
  up: async (arg) => {
    // Receives the Skalex tx proxy.
    expectAssignable<Skalex>(arg);
  },
};
db.addMigration(migration);
expectAssignable<MigrationStatus>(db.migrationStatus());

// ─── Plugin shape ──────────────────────────────────────────────────────────

const plugin: Plugin = {
  async beforeInsert(ctx) {
    expectAssignable<PluginInsertContext>(ctx);
  },
  async afterInsert(ctx) {
    expectAssignable<PluginInsertContext>(ctx);
  },
  async beforeUpdate(ctx) {
    expectAssignable<PluginUpdateContext>(ctx);
  },
};
db.use(plugin);

// ─── Watch ─────────────────────────────────────────────────────────────────

const unsubscribe = db.watch((event) => {
  expectAssignable<{ op: string; collection: string }>(event);
});
expectType<() => void>(unsubscribe);

// ─── MCP ────────────────────────────────────────────────────────────────────

const mcp = db.mcp();
expectAssignable<SkalexMCPServer>(mcp);

// ─── Connectors ────────────────────────────────────────────────────────────

expectAssignable<StorageAdapter>(new FsAdapter({ dir: "./data" }));
expectAssignable<StorageAdapter>(new LocalStorageAdapter());
expectAssignable<StorageAdapter>(new EncryptedAdapter(new FsAdapter({ dir: "./data" }), "00".repeat(32)));
// Dynamic bindings - we can't construct a real D1 binding here, but the
// class itself should be exported and extend StorageAdapter.
type D1Ctor = new (d1: any, opts?: any) => D1Adapter;
expectAssignable<D1Ctor>(D1Adapter);
type BunSQLiteCtor = new (opts: any) => BunSQLiteAdapter;
expectAssignable<BunSQLiteCtor>(BunSQLiteAdapter);
type LibSQLCtor = new (client: any, opts?: any) => LibSQLAdapter;
expectAssignable<LibSQLCtor>(LibSQLAdapter);

// Embedding + LLM adapter constructors.
type OpenAIEmbedCtor = new (opts: any) => OpenAIEmbeddingAdapter;
expectAssignable<OpenAIEmbedCtor>(OpenAIEmbeddingAdapter);
type OllamaEmbedCtor = new (opts: any) => OllamaEmbeddingAdapter;
expectAssignable<OllamaEmbedCtor>(OllamaEmbeddingAdapter);
type OpenAILLMCtor = new (opts: any) => OpenAILLMAdapter;
expectAssignable<OpenAILLMCtor>(OpenAILLMAdapter);
type AnthropicLLMCtor = new (opts: any) => AnthropicLLMAdapter;
expectAssignable<AnthropicLLMCtor>(AnthropicLLMAdapter);
type OllamaLLMCtor = new (opts: any) => OllamaLLMAdapter;
expectAssignable<OllamaLLMCtor>(OllamaLLMAdapter);

// ─── Error classes (named + static) ────────────────────────────────────────

expectAssignable<typeof SkalexError>(SkalexError);
expectAssignable<typeof ValidationError>(ValidationError);
expectAssignable<typeof UniqueConstraintError>(UniqueConstraintError);
expectAssignable<typeof TransactionError>(TransactionError);
expectAssignable<typeof PersistenceError>(PersistenceError);
expectAssignable<typeof AdapterError>(AdapterError);
expectAssignable<typeof QueryError>(QueryError);

function errorCheck(e: Error) {
  if (e instanceof ValidationError) {
    expectAssignable<string>(e.code);
    expectAssignable<Record<string, unknown>>(e.details);
  }
}

// ─── ChangeLog ─────────────────────────────────────────────────────────────

function checkChangeLog(c: ChangeLog) {
  expectAssignable<ChangeLog>(c);
}
// ChangeLogEntry.doc is a Document (has _id/createdAt/updatedAt);
// timestamp is a Date instance.
expectAssignable<ChangeLogEntry>({
  _id: "1",
  op: "insert",
  collection: "users",
  docId: "u1",
  doc: { _id: "u1", createdAt: new Date(), updatedAt: new Date() },
  timestamp: new Date(),
});

// ─── Search ────────────────────────────────────────────────────────────────

const searchOpts: SearchOptions = { limit: 10, minScore: 0.5 };
expectAssignable<SearchOptions>(searchOpts);
users.search("query", searchOpts).then((r) => {
  expectAssignable<SearchResult>(r);
});

// ─── Inspection ────────────────────────────────────────────────────────────

expectAssignable<CollectionStats | CollectionStats[]>(db.stats());
expectAssignable<CollectionInfo | null>(db.inspect("users"));

// ─── Negative checks ───────────────────────────────────────────────────────

// TransactionOptions.deferredEffectErrors rejects invalid strings.
expectError<TransactionOptions>({ deferredEffectErrors: "whoops" as const });
// SkalexConfig.deferredEffectErrors rejects invalid strings.
expectError<SkalexConfig>({ deferredEffectErrors: "loud" as const });
