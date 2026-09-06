import MemoryAdapter from "../helpers/MemoryAdapter.js";

/** Verify adapter-write ordering using the runtime's built database class. */
export default async function saveOrdering(Skalex, assert) {
  const adapter = new MemoryAdapter(), db = new Skalex({ adapter });
  await db.connect();
  await db.useCollection("items").insertOne({ _id: "x", value: 0 }, { save: true });
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const write = adapter.write.bind(adapter), writeAll = adapter.writeAll.bind(adapter);
  let pause = true;
  const order = [];
  adapter.write = async (name, data) => {
    if (name === "items" && pause) {
      pause = false;
      entered();
      await gate;
      await write(name, data);
      order.push("old");
    } else await write(name, data);
  };
  adapter.writeAll = async entries => {
    order.push("batch");
    await writeAll(entries);
  };
  const saving = db.saveData("items");
  await started;
  let prepared;
  const ready = new Promise(resolve => { prepared = resolve; });
  const committing = db.transaction(async tx => {
    await tx.useCollection("items").updateOne({ _id: "x" }, { value: 1 });
    prepared();
  });
  await ready;
  await new Promise(resolve => setTimeout(resolve, 0));
  release();
  await Promise.all([saving, committing]);
  assert("ordinary save completes before later transaction batch", order.join(",") === "old,batch");
  const reopened = new Skalex({ adapter });
  await reopened.connect();
  assert("reloaded data retains the committed value", (await reopened.useCollection("items").findOne({ _id: "x" })).value === 1);
}
