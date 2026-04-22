/**
 * tsd tests for connector subpath type declarations.
 *
 * Each `skalex/connectors/*` subpath has its own .d.ts file. These tests
 * import directly from those declaration files (via relative paths since
 * tsd runs in-package) and assert that the exposed classes match the root
 * type contract.
 */
import { expectAssignable } from "tsd";

import FsAdapter from "../../src/connectors/storage/fs.js";
import EncryptedAdapter from "../../src/connectors/storage/encrypted.js";
import LocalStorageAdapter from "../../src/connectors/storage/local.js";
import D1Adapter from "../../src/connectors/storage/d1.js";
import BunSQLiteAdapter from "../../src/connectors/storage/bun-sqlite.js";
import LibSQLAdapter from "../../src/connectors/storage/libsql.js";

import {
  StorageAdapter as RootStorageAdapter,
  FsAdapter as RootFsAdapter,
} from "../../dist/skalex.js";
import {
  StorageAdapter,
  FsAdapter as NamedFsAdapter,
  D1Adapter as NamedD1Adapter,
} from "../../src/connectors/index.js";
import {
  StorageAdapter as StorageStorageAdapter,
  BunSQLiteAdapter as StorageBunSQLiteAdapter,
} from "../../src/connectors/storage/index.js";
import {
  EmbeddingAdapter,
  OpenAIEmbeddingAdapter,
  OllamaEmbeddingAdapter,
} from "../../src/connectors/embedding/index.js";
import {
  LLMAdapter,
  OpenAILLMAdapter,
  AnthropicLLMAdapter,
  OllamaLLMAdapter,
} from "../../src/connectors/llm/index.js";

// Default exports resolve to the same classes as the root types.
expectAssignable<typeof RootFsAdapter>(FsAdapter);
expectAssignable<typeof RootFsAdapter>(NamedFsAdapter);

// Subpath-named exports are the same classes as root-named exports.
expectAssignable<typeof RootStorageAdapter>(StorageAdapter);
expectAssignable<typeof RootStorageAdapter>(StorageStorageAdapter);

// Each per-connector subpath exposes the concrete adapter.
const fs = new FsAdapter({ dir: "/tmp" });
expectAssignable<RootStorageAdapter>(fs);

const enc = new EncryptedAdapter(fs, "0".repeat(64));
expectAssignable<RootStorageAdapter>(enc);

const local = new LocalStorageAdapter();
expectAssignable<RootStorageAdapter>(local);

const d1 = new D1Adapter({} as object);
expectAssignable<RootStorageAdapter>(d1);

const bun = new BunSQLiteAdapter(":memory:");
expectAssignable<RootStorageAdapter>(bun);

const libsql = new LibSQLAdapter({} as object);
expectAssignable<RootStorageAdapter>(libsql);

expectAssignable<typeof NamedD1Adapter>(D1Adapter);
expectAssignable<typeof StorageBunSQLiteAdapter>(BunSQLiteAdapter);

// Embedding subpath: base class and two concrete adapters.
const oaEmbed = new OpenAIEmbeddingAdapter({ apiKey: "x" });
expectAssignable<EmbeddingAdapter>(oaEmbed);

const ollamaEmbed = new OllamaEmbeddingAdapter();
expectAssignable<EmbeddingAdapter>(ollamaEmbed);

// LLM subpath: base class and three concrete adapters.
const oaLLM = new OpenAILLMAdapter({ apiKey: "x" });
expectAssignable<LLMAdapter>(oaLLM);

const anthropicLLM = new AnthropicLLMAdapter({ apiKey: "x" });
expectAssignable<LLMAdapter>(anthropicLLM);

const ollamaLLM = new OllamaLLMAdapter();
expectAssignable<LLMAdapter>(ollamaLLM);
