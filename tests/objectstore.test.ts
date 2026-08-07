import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fsObjectStore } from "../src/objectstore.js";

describe("fsObjectStore", () => {
  let root: string;
  let store: ReturnType<typeof fsObjectStore>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "fieldops-objectstore-"));
    store = fsObjectStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("puts, gets, and checks existence", async () => {
    await store.put("corpus/doc_abc.txt", Buffer.from("hello"), "text/plain");
    expect(await store.exists("corpus/doc_abc.txt")).toBe(true);
    const bytes = await store.get("corpus/doc_abc.txt");
    expect(bytes.toString()).toBe("hello");
  });

  it("does not leave a temporary file after put", async () => {
    await store.put("corpus/doc_def.txt", Buffer.from("complete"), "text/plain");
    const files = await readdir(join(root, "corpus"));
    expect(files).toEqual(["doc_def.txt"]);
  });

  it("rejects keys that escape the root", async () => {
    await expect(store.put("../escape.txt", Buffer.from("bad"), "text/plain")).rejects.toThrow();
  });
});
