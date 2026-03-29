/**
 * Unit tests for events.js — EventBus.
 */
import { describe, test, expect, vi } from "vitest";
import EventBus from "../../src/events.js";

describe("EventBus — on / emit / off", () => {
  test("emits to registered listeners", () => {
    const bus = new EventBus();
    const fn  = vi.fn();
    bus.on("users", fn);
    bus.emit("users", { op: "insert" });
    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith({ op: "insert" });
  });

  test("on() returns an unsubscribe function", () => {
    const bus  = new EventBus();
    const fn   = vi.fn();
    const unsub = bus.on("users", fn);
    unsub();
    bus.emit("users", {});
    expect(fn).not.toHaveBeenCalled();
  });

  test("off() removes a specific listener", () => {
    const bus = new EventBus();
    const fn  = vi.fn();
    bus.on("users", fn);
    bus.off("users", fn);
    bus.emit("users", {});
    expect(fn).not.toHaveBeenCalled();
  });

  test("multiple listeners on the same event all fire", () => {
    const bus = new EventBus();
    const a   = vi.fn();
    const b   = vi.fn();
    bus.on("col", a);
    bus.on("col", b);
    bus.emit("col", { op: "delete" });
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  test("listeners on different events are isolated", () => {
    const bus = new EventBus();
    const fn  = vi.fn();
    bus.on("a", fn);
    bus.emit("b", {});
    expect(fn).not.toHaveBeenCalled();
  });

  test("emit on event with no listeners does not throw", () => {
    const bus = new EventBus();
    expect(() => bus.emit("nonexistent", {})).not.toThrow();
  });

  test("listener errors are swallowed — other listeners still fire", () => {
    const bus = new EventBus();
    const bad  = () => { throw new Error("boom"); };
    const good = vi.fn();
    bus.on("col", bad);
    bus.on("col", good);
    expect(() => bus.emit("col", {})).not.toThrow();
    expect(good).toHaveBeenCalledOnce();
  });

  test("removeAll(event) removes all listeners for that event", () => {
    const bus = new EventBus();
    const fn  = vi.fn();
    bus.on("col", fn);
    bus.removeAll("col");
    bus.emit("col", {});
    expect(fn).not.toHaveBeenCalled();
  });

  test("removeAll() removes all listeners on all events", () => {
    const bus = new EventBus();
    const a   = vi.fn();
    const b   = vi.fn();
    bus.on("a", a);
    bus.on("b", b);
    bus.removeAll();
    bus.emit("a", {});
    bus.emit("b", {});
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });

  test("listenerCount() returns accurate count", () => {
    const bus = new EventBus();
    expect(bus.listenerCount("col")).toBe(0);
    const u1 = bus.on("col", () => {});
    const u2 = bus.on("col", () => {});
    expect(bus.listenerCount("col")).toBe(2);
    u1();
    expect(bus.listenerCount("col")).toBe(1);
    u2();
    expect(bus.listenerCount("col")).toBe(0);
  });
});

// ─── Integration: collection.watch() ─────────────────────────────────────────

import Skalex from "../../src/index.js";
import MemoryAdapter from "../helpers/MemoryAdapter.js";

function makeDb() {
  return new Skalex({ adapter: new MemoryAdapter() });
}

describe("collection.watch() — callback API", () => {
  test("fires on insertOne", async () => {
    const db  = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    const events = [];
    const unsub = col.watch(e => events.push(e));

    await col.insertOne({ name: "a" });
    expect(events).toHaveLength(1);
    expect(events[0].op).toBe("insert");
    expect(events[0].doc.name).toBe("a");

    unsub();
    await db.disconnect();
  });

  test("fires on updateOne", async () => {
    const db  = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    const { data } = await col.insertOne({ val: 1 });
    const events = [];
    col.watch(e => events.push(e));
    await col.updateOne({ _id: data._id }, { val: 2 });
    expect(events).toHaveLength(1);
    expect(events[0].op).toBe("update");
    await db.disconnect();
  });

  test("fires on deleteOne", async () => {
    const db  = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    const { data } = await col.insertOne({ val: 1 });
    const events = [];
    col.watch(e => events.push(e));
    await col.deleteOne({ _id: data._id });
    expect(events).toHaveLength(1);
    expect(events[0].op).toBe("delete");
    await db.disconnect();
  });

  test("filter restricts events to matching docs", async () => {
    const db  = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    const events = [];
    col.watch({ active: true }, e => events.push(e));
    await col.insertOne({ active: true,  name: "visible"  });
    await col.insertOne({ active: false, name: "hidden"   });
    expect(events).toHaveLength(1);
    expect(events[0].doc.name).toBe("visible");
    await db.disconnect();
  });

  test("unsub stops receiving events", async () => {
    const db  = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    const events = [];
    const unsub = col.watch(e => events.push(e));
    await col.insertOne({ v: 1 });
    unsub();
    await col.insertOne({ v: 2 });
    expect(events).toHaveLength(1);
    await db.disconnect();
  });

  test("multiple watchers on the same collection all fire", async () => {
    const db  = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    const a = [], b = [];
    col.watch(e => a.push(e));
    col.watch(e => b.push(e));
    await col.insertOne({ v: 1 });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    await db.disconnect();
  });
});

describe("collection.watch() — AsyncIterator API", () => {
  test("yields insert events", async () => {
    const db  = makeDb();
    await db.connect();
    const col = db.useCollection("items");

    const iter = col.watch();
    const prom = iter.next(); // waiting for first event

    await col.insertOne({ val: 42 });

    const { value, done } = await prom;
    expect(done).toBe(false);
    expect(value.op).toBe("insert");
    expect(value.doc.val).toBe(42);

    await iter.return(); // clean up
    await db.disconnect();
  });

  test("return() stops the iterator", async () => {
    const db  = makeDb();
    await db.connect();
    const col = db.useCollection("items");
    const iter = col.watch();
    await iter.return();
    const { done } = await iter.next();
    expect(done).toBe(true);
    await db.disconnect();
  });
});
