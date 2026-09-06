import MemoryAdapter from "../helpers/MemoryAdapter.js";
/** Verify compressed memory retrieval through the runtime's built artifact. */
export default async function memoryCompression(Skalex, assert) {
  const db = new Skalex({
    adapter: new MemoryAdapter(),
    embeddingAdapter: { embed: () => Promise.resolve([1, 0]) },
    llmAdapter: { summarize: () => Promise.resolve("summary") },
  });
  try {
    const memory = db.useMemory("smoke_compression");
    await memory.remember("important memory");
    await memory.compress({ threshold: 0, keepRecent: 0 });
    assert("compressed memory remains retrievable", (await memory.recall("important")).docs[0]?.text === "summary");
    assert("compression replaces selected originals", (await memory.history()).length === 1);
  } finally { await db.disconnect(); }
}
