import MemoryAdapter from "../helpers/MemoryAdapter.js";

/** Detect a partial sequential batch with each runtime's built artifact. */
export default async function partialBatch(Skalex, assert) {
  const adapter = new MemoryAdapter(), db = new Skalex({ adapter, logger: () => {} });
  await db.connect();
  for (const name of ["a", "b"]) await db.useCollection(name).insertOne({ _id: "x", n: 0 });
  await db.saveData();
  adapter.throwOnWrite = name => name === "b";
  let failure;
  try {
    await db.transaction(async tx => {
      for (const name of ["a", "b"]) await tx.useCollection(name).updateOne({ _id: "x" }, { n: 1 });
    });
  } catch (error) { failure = error; }
  assert("partial batch rejects", failure?.code === "ERR_SKALEX_PERSISTENCE_FLUSH_FAILED");
  adapter.throwOnWrite = false;
  await db.transaction(tx => tx.useCollection("other").insertOne({ n: 2 }));
  const warnings = [], reopened = new Skalex({ adapter, logger: message => warnings.push(message) });
  await reopened.connect();
  assert("unrelated commit preserves partial-batch warning", warnings.some(message => /Incomplete flush/.test(message)));
  assert("detection does not claim automatic rollback",
    (await reopened.useCollection("a").findOne({ _id: "x" })).n === 1 &&
    (await reopened.useCollection("b").findOne({ _id: "x" })).n === 0);
  await reopened.acknowledgeIncompleteFlush();
  const after = [], checked = new Skalex({ adapter, logger: message => after.push(message) });
  await checked.connect();
  assert("acknowledgement clears the warning on reconnect", !after.some(message => /Incomplete flush/.test(message)));
  assert("acknowledgement leaves partial data unchanged", (await checked.useCollection("b").findOne({ _id: "x" })).n === 0);
}
