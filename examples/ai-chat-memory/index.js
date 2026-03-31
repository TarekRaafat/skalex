/**
 * AI Chat with Persistent Memory
 * ─────────────────────────────────────────────────────────────────────────────
 * Demonstrates Skalex's episodic agent memory API. Exchanges from a
 * simulated multi-turn conversation are stored with semantic embeddings,
 * then recalled and formatted into an LLM-ready context string for the
 * next turn — all persisted across process restarts.
 *
 * What this covers:
 *   db.useMemory(sessionId)        — per-session episodic store
 *   memory.remember(text)          — store with automatic embedding
 *   memory.recall(query, opts)     — semantic search over stored memories
 *   memory.context({ tokens })     — token-budgeted context string
 *   memory.history(opts)           — chronological listing
 *   memory.tokenCount()            — estimate token usage
 *   memory.compress({ threshold }) — summarise old entries via LLM
 *
 * Requirements:
 *   OPENAI_KEY env var (or swap provider to "ollama" for local, zero-cost)
 *
 * Run:
 *   OPENAI_KEY=sk-... node index.js
 *   OPENAI_KEY=sk-... node index.js my-session-id   # named session
 */

import Skalex from "skalex";

const SESSION_ID = process.argv[2] ?? "demo-session";

if (!process.env.OPENAI_KEY) {
  console.error(
    "\nMissing OPENAI_KEY.\n" +
    "  Set OPENAI_KEY=sk-... to use OpenAI embeddings.\n" +
    "  Or swap the config below to: provider: 'ollama', embedModel: 'nomic-embed-text'\n"
  );
  process.exit(1);
}

const db = new Skalex({
  path: "./.db",
  ai: {
    provider:   "openai",
    apiKey:     process.env.OPENAI_KEY,
    embedModel: "text-embedding-3-small",
    model:      "gpt-4o-mini",            // required only for memory.compress()
  },
});

await db.connect();

const memory = db.useMemory(SESSION_ID);

// ── Step 1: Store a simulated conversation ────────────────────────────────────

const exchanges = [
  "User: My name is Alice and I'm building an AI customer support agent.",
  "Assistant: Nice to meet you Alice! What kind of support does your agent handle?",
  "User: Returns, order tracking, and product questions for my e-commerce store.",
  "Assistant: Got it. Do you want the agent to escalate complex issues to a human?",
  "User: Yes, and it must remember past conversations so users don't repeat themselves.",
  "Assistant: Skalex's episodic memory is exactly built for that. Each session is isolated.",
  "User: My store sells electronics — laptops, phones, and accessories.",
  "Assistant: Noted. I can help you structure product categories and FAQ embeddings.",
];

console.log(`\nSession: ${SESSION_ID}`);
console.log("─── Storing conversation history ───\n");

for (const text of exchanges) {
  await memory.remember(text);
  console.log(`  stored: ${text.slice(0, 72)}...`);
}

// ── Step 2: Recall relevant memories for a follow-up question ─────────────────

const question = "What products does the user sell and what does their agent need?";
console.log(`\n─── Recalling context for: "${question}" ───\n`);

const { docs: recalled, scores } = await memory.recall(question, { limit: 4, minScore: 0.3 });

for (let i = 0; i < recalled.length; i++) {
  console.log(`  [${scores[i].toFixed(3)}] ${recalled[i].text}`);
}

// ── Step 3: Build a token-budgeted context string ─────────────────────────────

const ctx = memory.context({ tokens: 300 });

console.log("\n─── LLM-ready context string (300 token budget) ───\n");
console.log(ctx);

console.log("\n  → This string is ready to be injected into your LLM's system prompt.");
console.log("  → Example (OpenAI SDK):");
console.log("     openai.chat.completions.create({");
console.log("       messages: [");
console.log("         { role: 'system', content: 'You are a helpful assistant.\\n\\n' + ctx },");
console.log("         { role: 'user',   content: userMessage },");
console.log("       ]");
console.log("     })");

// ── Step 4: Inspect token usage and memory size ───────────────────────────────

const usage = memory.tokenCount();
console.log(`\n─── Memory stats ───\n`);
console.log(`  entries : ${usage.count}`);
console.log(`  tokens  : ~${usage.tokens}`);

// ── Step 5: Chronological history ─────────────────────────────────────────────

const recent = await memory.history({ limit: 3 });
console.log(`\n─── Last 3 entries (chronological) ───\n`);
for (const entry of recent) {
  console.log(`  [${entry.createdAt.toISOString()}] ${entry.text.slice(0, 70)}`);
}

// ── Step 6: Compress if memory exceeds threshold ──────────────────────────────
// compress() only acts when tokenCount() exceeds the threshold.
// Here we set a low threshold to demonstrate it on the small demo dataset.

console.log("\n─── Compressing memory (threshold: 200 tokens) ───");
await memory.compress({ threshold: 200 });

const after = memory.tokenCount();
console.log(`  before: ~${usage.tokens} tokens / ${usage.count} entries`);
console.log(`  after : ~${after.tokens} tokens / ${after.count} entries`);
if (after.count < usage.count) {
  console.log("  Old entries summarised into a single compressed entry.");
} else {
  console.log("  Nothing to compress (token count already within threshold).");
}

await db.disconnect();

console.log(`\n─── Done. Run again with session ID "${SESSION_ID}" to continue. ───\n`);
