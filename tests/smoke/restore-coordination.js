/** Historical restore lock checks against each runtime's built artifact. */
export default async function restoreCoordination(db, assert) {
  const name = "restore_guard";
  const col = db.createCollection(name, { changelog: true, schema: { value: { type: "number", unique: true } } });
  await col.insertOne({ _id: "x", value: 1 });
  await db.saveData(name);
  try {
    await db.transaction(async tx => {
      await tx.useCollection(name).updateOne({ _id: "x" }, { value: 2 });
      for (const [entry, target] of [["db", db], ["changelog", db.changelog()]]) {
        for (const [mode, options] of [["one", { _id: "x" }], ["all", {}]]) {
          let failure;
          try { await target.restore(name, new Date("2100-01-01"), options); }
          catch (error) { failure = error; }
          assert(entry + " " + mode + " restore respects transaction lock",
            failure?.code === "ERR_SKALEX_TX_COLLECTION_LOCKED");
        }
      }
      throw new Error("restore smoke rollback");
    });
  } catch (error) {
    if (error.message !== "restore smoke rollback") throw error;
  }
  assert("restore rejection preserves rollback data", (await col.findOne({ _id: "x" })).value === 1);
  const events = [];
  const unsubscribe = db.watch(event => { if (event.collection === name) events.push(event.op); });
  await db.restore(name, new Date(0));
  unsubscribe();
  assert("unlocked historical restore succeeds", await col.count() === 0);
  assert("historical restore preserves delete events", events.join(",") === "delete");
  await db.changelog().restore(name, new Date("2100-01-01"));
  assert("unique historical restore grows an empty collection", (await col.findOne({ _id: "x" })).value === 1);
}
