/**
 * Unit tests for memory.js — Memory class.
 */
import { describe, test, expect, beforeEach } from "vitest";
import Skalex from "../../src/index.js";
import MemoryAdapter from "../helpers/MemoryAdapter.js";
import MockEmbeddingAdapter from "../helpers/MockEmbeddingAdapter.js";
import MockAIAdapter from "../helpers/MockAIAdapter.js";

function makeDb() {
  const adapter = new MemoryAdapter();
  const db = new Skalex({ adapter });
  db._embeddingAdapter = new MockEmbeddingAdapter();
  db._aiAdapter = new MockAIAdapter();
  return db;
}

describe("Memory — remember / recall / history / forget", () => {
  test("remember() stores a text entry and returns the doc", async () => {
    const db = makeDb();
    const mem = db.useMemory("session-1");
    const { data } = await mem.remember("The sky is blue");
    expect(data._id).toBeDefined();
    expect(data.text).toBe("The sky is blue");
    expect(data.sessionId).toBe("session-1");
  });

  test("remember() embeds the text (calls embedding adapter)", async () => {
    const db = makeDb();
    const mem = db.useMemory("session-1");
    await mem.remember("test memory");
    expect(db._embeddingAdapter.calls).toHaveLength(1);
    expect(db._embeddingAdapter.calls[0]).toBe("test memory");
  });

  test("recall() performs semantic search", async () => {
    const db = makeDb();
    const mem = db.useMemory("session-1");
    await mem.remember("cats are great");
    await mem.remember("dogs are loyal");
    const { docs, scores } = await mem.recall("cats");
    expect(docs.length).toBeGreaterThan(0);
    expect(scores.length).toBe(docs.length);
  });

  test("history() returns docs in chronological order", async () => {
    const db = makeDb();
    const mem = db.useMemory("session-1");
    await mem.remember("first");
    await mem.remember("second");
    await mem.remember("third");
    const docs = await mem.history();
    expect(docs).toHaveLength(3);
    expect(docs[0].text).toBe("first");
    expect(docs[2].text).toBe("third");
  });

  test("history() respects limit option", async () => {
    const db = makeDb();
    const mem = db.useMemory("session-1");
    await mem.remember("a");
    await mem.remember("b");
    await mem.remember("c");
    const docs = await mem.history({ limit: 2 });
    expect(docs).toHaveLength(2);
  });

  test("forget() removes a specific memory by id", async () => {
    const db = makeDb();
    const mem = db.useMemory("session-1");
    const { data } = await mem.remember("to forget");
    await mem.forget(data._id);
    const docs = await mem.history();
    expect(docs.find(d => d._id === data._id)).toBeUndefined();
  });

  test("forget() returns null for unknown id", async () => {
    const db = makeDb();
    const mem = db.useMemory("session-1");
    const result = await mem.forget("nonexistent-id");
    expect(result).toBeNull();
  });

  test("different sessions are isolated", async () => {
    const db = makeDb();
    const m1 = db.useMemory("session-A");
    const m2 = db.useMemory("session-B");
    await m1.remember("A memory");
    const docsA = await m1.history();
    const docsB = await m2.history();
    expect(docsA).toHaveLength(1);
    expect(docsB).toHaveLength(0);
  });
});

describe("Memory — tokenCount / context", () => {
  test("tokenCount() returns 0 for empty memory", () => {
    const db = makeDb();
    const mem = db.useMemory("s");
    const { tokens, count } = mem.tokenCount();
    expect(tokens).toBe(0);
    expect(count).toBe(0);
  });

  test("tokenCount() estimates tokens as ceil(chars / 4)", async () => {
    const db = makeDb();
    const mem = db.useMemory("s");
    await mem.remember("abcd"); // 4 chars → 1 token
    const { tokens, count } = mem.tokenCount();
    expect(tokens).toBe(1);
    expect(count).toBe(1);
  });

  test("context() returns newline-joined memory string", async () => {
    const db = makeDb();
    const mem = db.useMemory("s");
    await mem.remember("fact one");
    await mem.remember("fact two");
    const ctx = mem.context();
    expect(ctx).toContain("fact one");
    expect(ctx).toContain("fact two");
  });

  test("context() respects token budget", async () => {
    const db = makeDb();
    const mem = db.useMemory("s");
    // Each entry ≈ 1 token (4 chars each)
    await mem.remember("aaaa");
    await mem.remember("bbbb");
    await mem.remember("cccc");
    // Budget of 2 tokens should include at most 2 entries
    const ctx = mem.context({ tokens: 2 });
    const lines = ctx.split("\n").filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(2);
  });

  test("context() contains all memories within budget", async () => {
    const db = makeDb();
    const mem = db.useMemory("s");
    await mem.remember("first memory");
    await mem.remember("second memory");
    const ctx = mem.context();
    expect(ctx).toContain("first memory");
    expect(ctx).toContain("second memory");
  });
});

describe("Memory — compress", () => {
  test("compress() does nothing when under threshold", async () => {
    const db = makeDb();
    const mem = db.useMemory("s");
    await mem.remember("short text");
    await mem.compress({ threshold: 8000 });
    expect(db._aiAdapter.summarizeCalls).toHaveLength(0);
  });

  test("compress() calls summarize when over threshold", async () => {
    const db = makeDb();
    const mem = db.useMemory("s");
    // Force threshold to 0 so any content triggers compression
    for (let i = 0; i < 15; i++) {
      await mem.remember(`memory number ${i}`);
    }
    await mem.compress({ threshold: 0 });
    expect(db._aiAdapter.summarizeCalls).toHaveLength(1);
  });

  test("compress() keeps the 10 most recent entries + 1 summary", async () => {
    const db = makeDb();
    const mem = db.useMemory("s");
    for (let i = 0; i < 15; i++) {
      await mem.remember(`entry ${i}`);
    }
    await mem.compress({ threshold: 0 });
    const docs = await mem.history();
    // 10 kept + 1 summary = 11
    expect(docs).toHaveLength(11);
  });

  test("compress() inserts a compressed:true summary doc", async () => {
    const db = makeDb();
    const mem = db.useMemory("s");
    for (let i = 0; i < 15; i++) {
      await mem.remember(`entry ${i}`);
    }
    await mem.compress({ threshold: 0 });
    const docs = await mem.history();
    const summary = docs.find(d => d.compressed === true);
    expect(summary).toBeDefined();
    expect(summary.text).toMatch(/Summary of \d+ memories/);
  });

  test("compress() throws when no AI adapter is configured", async () => {
    const db = makeDb();
    db._aiAdapter = null;
    const mem = db.useMemory("s");
    for (let i = 0; i < 15; i++) {
      await mem.remember(`entry ${i}`);
    }
    await expect(mem.compress({ threshold: 0 })).rejects.toThrow(/language model adapter/);
  });
});
