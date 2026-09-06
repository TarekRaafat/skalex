/**
 * Shared public-API ownership checks against each runtime's built artifact.
 */
export default async function transactionOwnership(db, assert) {
  const bare = db.useCollection("ownership");
  let entered, release;
  const waiting = new Promise(r => { entered = r; });
  const resumed = new Promise(r => { release = r; });
  db.use({ beforeInsert: async ({ collection, doc }) => {
    if (collection === "ownership" && doc._id === "owned") {
      entered();
      await resumed;
    }
  } });
  let captured;
  const running = db.transaction(async tx => {
    const owned = tx.useCollection("ownership");
    captured = owned.insertOne;
    await captured({ _id: "owned" });
  });
  await waiting;
  let lockError;
  try { await bare.insertOne({ _id: "outside" }); } catch (error) { lockError = error; }
  release();
  await running;
  assert("awaited tx hook retains collection ownership", lockError?.code === "ERR_SKALEX_TX_COLLECTION_LOCKED");
  let staleError;
  try { await captured({ _id: "stale" }); } catch (error) { staleError = error; }
  assert("captured tx method expires", staleError?.code === "ERR_SKALEX_TX_STALE_PROXY");
  try {
    await db.transaction(async tx => {
      await tx.useCollection("rollback_owned").insertOne({ _id: "discard" });
      await db.useCollection("rollback_outside").insertOne({ _id: "keep" });
      throw new Error("rollback");
    });
  } catch (error) {
    if (error.message !== "rollback") throw error;
  }
  assert("rollback preserves independent creation",
    (await db.useCollection("rollback_outside").findOne({ _id: "keep" }))?._id === "keep");
  assert("rollback removes owned creation", !Object.hasOwn(db.collections, "rollback_owned"));
}


/** Shared capability checks, using each runtime's built database instance. */
export async function transactionSurface(db, assert) {
  for (const [name, operation] of [
    ["saveData", tx => tx.saveData("surface_items")],
    ["seed", tx => tx.seed({ surface_escape: [{ _id: "escape" }] })],
    ["restore", tx => tx.restore("surface_items", new Date())],
    ["collection export", tx => tx.useCollection("surface_items").export()],
  ]) {
    let denied;
    try {
      await db.transaction(async tx => {
        await tx.useCollection("surface_items").insertOne({ _id: name });
        await operation(tx);
      });
    } catch (error) { denied = error; }
    assert("transaction denies " + name, denied?.code === "ERR_SKALEX_TX_DIRECT_ACCESS");
    assert("rejected capability rolls back " + name, !Object.hasOwn(db.collections, "surface_items"));
  }
  assert("blocked seed creates no collection", !Object.hasOwn(db.collections, "surface_escape"));
}
