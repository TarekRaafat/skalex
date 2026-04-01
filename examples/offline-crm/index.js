/**
 * Offline CRM
 * ─────────────────────────────────────────────────────────────────────────────
 * A complete offline-first CRM with Contacts, Companies, and Deals.
 * No API keys, no server, no internet connection required.
 *
 * What this covers:
 *   createCollection(name, { schema, indexes })   -  validation + O(1) lookups
 *   insertMany / insertOne                         -  bulk and single inserts
 *   find(filter, { sort, page, limit, populate })  -  sorted, paginated, populated
 *   findOne(filter)                                -  single doc lookup
 *   updateOne(filter, update)                      -  field updates + $push
 *   deleteOne / deleteMany                         -  removal
 *   upsert(filter, update)                         -  insert-or-update
 *   count / sum / avg / groupBy                    -  aggregations
 *   db.transaction(fn)                             -  atomic multi-collection write
 *   collection.export(filter, { format, dir })     -  CSV export
 *   db.namespace(id)                               -  per-tenant isolation
 *   collection.watch(callback)                     -  reactive mutation events
 *
 * Note on populate:
 *   Skalex populate resolves foreign keys by matching the field name to the
 *   collection name. A field named "contacts" in the deals collection is looked
 *   up in the "contacts" collection by _id. Keep field names aligned with their
 *   target collection name.
 *
 * Run:
 *   node index.js
 */

import Skalex from "skalex";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir }              from "node:os";
import { join }                from "node:path";

// Use a temp dir so each run is clean
const dir = mkdtempSync(join(tmpdir(), "skalex-crm-"));

const db = new Skalex({ path: dir, format: "json" });

// ── Schema definitions ────────────────────────────────────────────────────────

db.createCollection("companies", {
  schema: {
    name:     { type: "string",  required: true, unique: true },
    industry: { type: "string",  required: true, enum: ["saas", "ecommerce", "fintech", "health", "other"] },
    size:     { type: "string",  enum: ["startup", "smb", "enterprise"] },
    website:  "string",
  },
  indexes: ["industry", "size"],
});

db.createCollection("contacts", {
  schema: {
    email:    { type: "string", required: true, unique: true },
    name:     { type: "string", required: true },
    companies: { type: "string", required: true },  // _id → companies collection
    role:     "string",
    phone:    "string",
  },
  indexes: ["companies", "role"],
});

db.createCollection("deals", {
  schema: {
    title:    { type: "string", required: true },
    contacts: { type: "string", required: true },   // _id → contacts collection
    companies: { type: "string", required: true },  // _id → companies collection
    value:    { type: "number", required: true },
    stage:    { type: "string", required: true, enum: ["lead", "qualified", "proposal", "closed-won", "closed-lost"] },
    currency: "string",
  },
  indexes: ["stage", "companies", "contacts"],
  changelog: true,   // track every deal mutation for audit
});

await db.connect();

const companies = db.useCollection("companies");
const contacts  = db.useCollection("contacts");
const deals     = db.useCollection("deals");

// ── Seed initial data ─────────────────────────────────────────────────────────

console.log("\n─── Seeding CRM data ───\n");

const acme  = await companies.insertOne({ name: "Acme Corp",    industry: "saas",      size: "smb",        website: "acme.io" });
const nova  = await companies.insertOne({ name: "Nova Health",  industry: "health",    size: "startup",    website: "novahealth.co" });
const vault = await companies.insertOne({ name: "Vault Fin",    industry: "fintech",   size: "enterprise", website: "vaultfin.com" });

const alice = await contacts.insertOne({ name: "Alice Chen",  email: "alice@acme.io",      companies: acme._id,  role: "CEO" });
const bob   = await contacts.insertOne({ name: "Bob Torres",  email: "bob@nova.co",        companies: nova._id,  role: "CTO" });
const carol = await contacts.insertOne({ name: "Carol Singh", email: "carol@vaultfin.com", companies: vault._id, role: "VP Sales" });
const david = await contacts.insertOne({ name: "David Kim",   email: "david@acme.io",      companies: acme._id,  role: "Engineer" });

await deals.insertMany([
  { title: "Acme  -  Platform license",  contacts: alice._id, companies: acme._id,  value: 24000, stage: "closed-won",  currency: "USD" },
  { title: "Acme  -  Add-on seats",      contacts: david._id, companies: acme._id,  value:  4800, stage: "proposal",    currency: "USD" },
  { title: "Nova  -  Pilot contract",    contacts: bob._id,   companies: nova._id,  value: 12000, stage: "qualified",   currency: "USD" },
  { title: "Vault  -  Enterprise deal",  contacts: carol._id, companies: vault._id, value: 95000, stage: "lead",        currency: "USD" },
  { title: "Vault  -  Support plan",     contacts: carol._id, companies: vault._id, value:  8400, stage: "closed-won",  currency: "USD" },
]);

console.log(`  companies : ${await companies.count()}`);
console.log(`  contacts  : ${await contacts.count()}`);
console.log(`  deals     : ${await deals.count()}`);

// ── Watch for deal changes ────────────────────────────────────────────────────

const dealEvents = [];
const unsub = deals.watch(event => dealEvents.push(event));

// ── Query: deals by stage with populate ───────────────────────────────────────

console.log("\n─── Open deals (lead + qualified + proposal) ───\n");

const { docs: openDeals } = await deals.find(
  { stage: { $in: ["lead", "qualified", "proposal"] } },
  {
    sort:     { value: -1 },
    populate: ["contacts", "companies"],
  }
);

for (const deal of openDeals) {
  const contact = deal.contacts;
  const company = deal.companies;
  console.log(
    `  ${deal.title.padEnd(28)} $${String(deal.value).padStart(7)}  ` +
    `[${deal.stage.padEnd(9)}]  ${contact?.name} @ ${company?.name}`
  );
}

// ── Aggregation: pipeline by stage ────────────────────────────────────────────

console.log("\n─── Pipeline summary ───\n");

const byStage       = await deals.groupBy("stage");
const totalPipeline = await deals.sum("value");
const wonRevenue    = await deals.sum("value", { stage: "closed-won" });
const avgDealSize   = await deals.avg("value");

console.log("  Stage breakdown:");
for (const [stage, stageDocs] of Object.entries(byStage)) {
  const total = stageDocs.reduce((s, d) => s + d.value, 0);
  console.log(`    ${stage.padEnd(14)}  ${String(stageDocs.length).padStart(2)} deals   $${total.toLocaleString()}`);
}

console.log(`\n  Total pipeline  : $${totalPipeline.toLocaleString()}`);
console.log(`  Won revenue     : $${wonRevenue.toLocaleString()}`);
console.log(`  Avg deal size   : $${avgDealSize.toLocaleString()}`);

// ── Update: advance a deal stage ──────────────────────────────────────────────

console.log("\n─── Advancing Nova pilot to proposal ───");

await deals.updateOne(
  { title: "Nova  -  Pilot contract" },
  { stage: "proposal" },
  { session: "user-carol" }
);

const novaDeal = await deals.findOne({ title: "Nova  -  Pilot contract" });
console.log(`  New stage: ${novaDeal.stage}`);

// ── Transaction: close a deal and tag the contact ─────────────────────────────

console.log("\n─── Closing Vault enterprise deal (transaction) ───");

await db.transaction(async (tx) => {
  const txDeals    = tx.useCollection("deals");
  const txContacts = tx.useCollection("contacts");

  await txDeals.updateOne(
    { title: "Vault  -  Enterprise deal" },
    { stage: "closed-won" }
  );

  await txContacts.updateOne(
    { email: "carol@vaultfin.com" },
    { tags: { $push: "closed-enterprise" } }
  );
});

const carolAfter = await contacts.findOne({ email: "carol@vaultfin.com" });
console.log(`  Carol's tags: ${carolAfter.tags?.join(", ")}`);

const newWon = await deals.sum("value", { stage: "closed-won" });
console.log(`  Total won revenue: $${newWon.toLocaleString()}`);

// ── Upsert: sync a contact from an external source ────────────────────────────

console.log("\n─── Upserting a contact from an external sync ───");

await contacts.upsert(
  { email: "eve@acme.io" },
  { name: "Eve Park", companies: acme._id, role: "Product Manager" }
);

// Second call updates the record
await contacts.upsert(
  { email: "eve@acme.io" },
  { role: "Head of Product" }
);

const eve = await contacts.findOne({ email: "eve@acme.io" });
console.log(`  Eve's role: ${eve.role}`);

// ── Pagination: contacts by company ───────────────────────────────────────────

console.log("\n─── Contacts at Acme Corp (page 1, 2 per page) ───\n");

const page1 = await contacts.find(
  { companies: acme._id },
  { sort: { name: 1 }, page: 1, limit: 2 }
);

console.log(`  Page 1 / ${page1.totalPages}  (${page1.totalDocs} total)`);
for (const c of page1.docs) {
  console.log(`    ${c.name.padEnd(18)} ${c.role}`);
}

// ── Schema validation ─────────────────────────────────────────────────────────

console.log("\n─── Schema validation ───");

try {
  await contacts.insertOne({ name: "Ghost", companies: acme._id });
} catch (err) {
  console.log(`  Missing required field  → ${err.message}`);
}

try {
  await deals.insertOne({
    title: "Bad deal", contacts: alice._id, companies: acme._id,
    value: 500, stage: "negotiating",   // invalid enum
  });
} catch (err) {
  console.log(`  Invalid enum value      → ${err.message}`);
}

try {
  await contacts.insertOne({ name: "Dup", email: "alice@acme.io", companies: nova._id });
} catch (err) {
  console.log(`  Unique constraint       → ${err.message}`);
}

// ── Namespace: isolate a second tenant ────────────────────────────────────────

console.log("\n─── Multi-tenant namespace ───");

const tenantB = db.namespace("tenant-beta");
await tenantB.connect();
const betaDeals = tenantB.useCollection("deals");
await betaDeals.insertOne({ title: "Beta deal", contacts: "x", companies: "y", value: 1000, stage: "lead" });
const { docs: betaOnly } = await betaDeals.find({});
console.log(`  Tenant Beta deals: ${betaOnly.length} (isolated from main tenant)`);
const { docs: mainDeals } = await deals.find({});
console.log(`  Main tenant deals: ${mainDeals.length} (unchanged)`);
await tenantB.disconnect();

// ── Watch events captured ─────────────────────────────────────────────────────

unsub();

console.log("\n─── Deal mutation events captured by watch() ───\n");
for (const ev of dealEvents) {
  console.log(`  [${ev.op.padEnd(6)}] ${ev.doc.title}`);
}

// ── Export ────────────────────────────────────────────────────────────────────

console.log("\n─── Exporting won deals to CSV ───");

const exportDir = join(dir, "exports");
await deals.export(
  { stage: "closed-won" },
  { format: "csv", dir: exportDir, name: "won-deals" }
);

console.log(`  Written to ${exportDir}/won-deals.csv`);

// ── Final stats ───────────────────────────────────────────────────────────────

console.log("\n─── Database stats ───\n");

const stats = db.stats();
for (const s of stats) {
  if (s.collection.startsWith("_")) continue;
  console.log(`  ${s.collection.padEnd(14)}  ${s.count} docs   ~${s.estimatedSize}B`);
}

await db.disconnect();

// Clean up temp dir
rmSync(dir, { recursive: true, force: true });

console.log("\n─── Done. ───\n");
