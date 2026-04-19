/**
 * Unit tests for src/engine/constants.js  -  frozen Ops and Hooks maps.
 */
import { describe, test, expect } from "vitest";
import { Ops, Hooks } from "../../src/engine/constants.js";

describe("engine constants", () => {
  test("Ops values match their string literals", () => {
    expect(Ops.INSERT).toBe("insert");
    expect(Ops.UPDATE).toBe("update");
    expect(Ops.DELETE).toBe("delete");
    expect(Ops.RESTORE).toBe("restore");
  });

  test("Hooks values match their string literals", () => {
    expect(Hooks.BEFORE_INSERT).toBe("beforeInsert");
    expect(Hooks.AFTER_INSERT).toBe("afterInsert");
    expect(Hooks.BEFORE_UPDATE).toBe("beforeUpdate");
    expect(Hooks.AFTER_UPDATE).toBe("afterUpdate");
    expect(Hooks.BEFORE_DELETE).toBe("beforeDelete");
    expect(Hooks.AFTER_DELETE).toBe("afterDelete");
  });

  test("Hooks.AFTER_RESTORE exists and equals 'afterRestore'", () => {
    expect(Hooks.AFTER_RESTORE).toBe("afterRestore");
  });

  test("both maps are frozen", () => {
    expect(Object.isFrozen(Ops)).toBe(true);
    expect(Object.isFrozen(Hooks)).toBe(true);
  });
});
