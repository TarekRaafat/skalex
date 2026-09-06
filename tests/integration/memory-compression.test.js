import { afterEach, expect, test } from "vitest";
import Skalex from "../../src/index.js";
import MemoryAdapter from "../helpers/MemoryAdapter.js";

const databases = [];
async function setup({ autoSave = false, memory, plugins = [] } = {}) {
  const adapter = new MemoryAdapter();
  const embedded = [];
  const embeddingAdapter = { embed: text => { embedded.push(text); return Promise.resolve([1, 0]); } };
  const llmAdapter = { summarize: () => Promise.resolve("summary") };
  const db = new Skalex({ adapter, embeddingAdapter, llmAdapter, autoSave, memory, plugins });
  databases.push({ db, adapter });
  const mem = db.useMemory("compression");
  await mem.remember("first important memory");
  await mem.remember("second important memory");
  return { db, mem, adapter, embeddingAdapter, llmAdapter, embedded };
}
afterEach(async () => { await Promise.all(databases.splice(0).map(({ db, adapter }) => { adapter.throwOnWrite = false; return db.disconnect(); })); });
const options = { threshold: 0, keepRecent: 0 };

test("compressed summary is embedded and remains retrievable after all originals are removed", async () => {
  const { mem, embedded } = await setup();
  await mem.compress(options);
  expect(embedded).toContain("summary");
  expect((await mem.history()).map(d => d.text)).toEqual(["summary"]);
  expect((await mem.recall("important")).docs[0]).toMatchObject({ text: "summary", compressed: true, sessionId: "compression" });
});

test.each(["summarize", "embed"])("%s failure retains every original", async stage => {
  const { mem, embeddingAdapter, llmAdapter } = await setup();
  const before = await mem.history();
  const fail = () => Promise.reject(new Error("injected " + stage));
  if (stage === "embed") embeddingAdapter.embed = fail;
  else llmAdapter.summarize = fail;
  await expect(mem.compress(options)).rejects.toThrow("injected");
  expect(await mem.history()).toEqual(before);
});

test("summary insertion hook failure retains every original", async () => {
  const { mem } = await setup({ plugins: [{ name: "reject-summary", beforeInsert: ({ doc }) => {
    if (doc.compressed) throw new Error("reject summary");
  } }] });
  const before = await mem.history();
  await expect(mem.compress(options)).rejects.toThrow("reject summary");
  expect(await mem.history()).toEqual(before);
});

test("summary persistence failure cannot delete originals in memory or storage", async () => {
  const { mem, adapter } = await setup({ autoSave: true });
  const before = await mem.history();
  const stored = (await adapter.read("_memory_compression"));
  adapter.throwOnWrite = true;
  await expect(mem.compress(options)).rejects.toThrow();
  const ids = (await mem.history()).map(d => d._id);
  expect(ids).toEqual(expect.arrayContaining(before.map(d => d._id)));
  expect((await adapter.read("_memory_compression"))).toBe(stored);
});

test("cleanup failure leaves originals and a retrievable summary", async () => {
  const { mem } = await setup({ plugins: [{ name: "reject-delete", beforeDelete: () => { throw new Error("reject cleanup"); } }] });
  const before = await mem.history();
  await expect(mem.compress(options)).rejects.toThrow("reject cleanup");
  const history = await mem.history();
  expect(history.map(d => d._id)).toEqual(expect.arrayContaining(before.map(d => d._id)));
  expect(history.find(d => d.compressed)?.text).toBe("summary");
  expect((await mem.recall("important")).docs.some(d => d.compressed)).toBe(true);
});

test("every persisted compression snapshot retains originals or the embedded summary", async () => {
  const { mem, adapter, db } = await setup({ autoSave: true });
  const originalIds = (await mem.history()).map(d => d._id);
  const writes = [];
  const write = adapter.write.bind(adapter);
  adapter.write = async (name, data) => { await write(name, data); if (name === "_memory_compression") writes.push(JSON.parse(data)); };
  await mem.compress(options);
  expect(writes.length).toBe(2);
  for (const snapshot of writes) {
    const docs = snapshot.data.data;
    expect(originalIds.every(id => docs.some(d => d._id === id)) || docs.some(d => d.compressed && d._vector?.length === 2)).toBe(true);
  }
  await db.disconnect();
  await db.connect();
  expect((await mem.recall("important")).docs[0]?.text).toBe("summary");
});

test("keepRecent preserves newest entries and skips embedding when nothing is selected", async () => {
  const { mem, embedded } = await setup();
  const before = await mem.history();
  await mem.compress({ threshold: 0, keepRecent: 2 });
  expect(embedded).toHaveLength(2);
  await mem.compress({ threshold: 0, keepRecent: 1 });
  const history = await mem.history();
  expect(history.some(d => d._id === before[1]._id)).toBe(true);
  expect(history.filter(d => d.compressed)).toHaveLength(1);
});

test("default compression does not force persistence", async () => {
  const { mem, adapter } = await setup();
  await mem.compress(options);
  expect((await adapter.read("_memory_compression"))).toBeNull();
});

test("automatic compression embeds its replacement", async () => {
  const { mem } = await setup({ memory: { maxEntries: 1, keepRecent: 0 } });
  expect((await mem.recall("important")).docs.some(d => d.compressed)).toBe(true);
});

test("memories added while summarization waits are not deleted", async () => {
  const { mem, llmAdapter } = await setup();
  let release;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  llmAdapter.summarize = () => { started(); return new Promise(resolve => { release = resolve; }); };
  const compression = mem.compress(options);
  await ready;
  const added = await mem.remember("new memory");
  release("summary");
  await compression;
  expect((await mem.history()).map(d => d._id)).toContain(added._id);
});

test("post-insert hook failure retains originals alongside the summary", async () => {
  const { mem } = await setup({ plugins: [{ afterInsert: ({ doc }) => {
    if (doc.compressed) throw new Error("after summary");
  } }] });
  const before = await mem.history();
  await expect(mem.compress(options)).rejects.toThrow("after summary");
  expect((await mem.history()).map(d => d._id)).toEqual(expect.arrayContaining(before.map(d => d._id)));
});

test("cleanup save failure leaves a recoverable persisted summary and originals", async () => {
  const { mem, adapter } = await setup({ autoSave: true });
  const write = adapter.write.bind(adapter);
  let writes = 0;
  adapter.write = (name, data) => {
    if (name === "_memory_compression" && ++writes === 2) return Promise.reject(new Error("cleanup save"));
    return write(name, data);
  };
  await expect(mem.compress(options)).rejects.toThrow("cleanup save");
  const persisted = JSON.parse((await adapter.read("_memory_compression"))).data.data;
  expect(persisted).toHaveLength(3);
  expect(persisted.find(d => d.compressed)?._vector).toEqual([1, 0]);
  expect((await mem.recall("important")).docs[0]?.text).toBe("summary");
});
