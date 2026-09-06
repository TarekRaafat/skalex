import { afterEach, describe, expect, test, vi } from "vitest";
import fs from "node:fs";
import FsAdapter from "../../src/connectors/storage/fs.js";

const uuid = "12345678-1234-4234-8234-123456789abc";
afterEach(() => vi.restoreAllMocks());

describe("filesystem temporary-file classification", () => {
  test.each(["json", "gz"])("preserves valid .tmp. collection names in %s", async format => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const names = ["orders.tmp.archive", "a.tmp.b", "plain"];
    const files = names.map(name => `${name}.${format}`);
    files.push(`.skalex-${uuid}.tmp.${format}`, "notes.tmp.txt", `other_${uuid}.tmp.txt`);
    vi.spyOn(fs.promises, "readdir").mockResolvedValue(files);
    const unlink = vi.spyOn(fs.promises, "unlink").mockResolvedValue();
    const adapter = new FsAdapter({ dir: "/virtual", format });
    expect(await adapter.list()).toEqual(names);
    expect(await adapter.cleanOrphans()).toBe(1);
    expect(unlink.mock.calls.map(([path]) => path.split("/").pop())).toEqual([`.skalex-${uuid}.tmp.${format}`]);
  });

  test("does not treat a valid collection ending in a UUID and .tmp as a temporary file", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const name = "a_12345678-1234-4234-8234-123456789abc.tmp";
    vi.spyOn(fs.promises, "readdir").mockResolvedValue([name + ".json"]);
    const unlink = vi.spyOn(fs.promises, "unlink").mockResolvedValue();
    const adapter = new FsAdapter({ dir: "/virtual", format: "json" });
    expect(await adapter.list()).toEqual([name]);
    expect(await adapter.cleanOrphans()).toBe(0);
    expect(unlink).not.toHaveBeenCalled();
  });
});
