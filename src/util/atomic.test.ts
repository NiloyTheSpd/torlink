import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { serializeWrites, writeJsonAtomic, writeJsonAtomicSync } from "./atomic";

describe("serializeWrites", () => {
  it("runs tasks in submission order, never interleaved", async () => {
    const write = serializeWrites();
    const order: number[] = [];
    const slow = (n: number, ms: number) => () =>
      new Promise<void>((resolve) => setTimeout(() => (order.push(n), resolve()), ms));

    const p1 = write(slow(1, 30));
    const p2 = write(slow(2, 5));
    const p3 = write(slow(3, 1));
    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("rejects the caller's promise when the write fails", async () => {
    const write = serializeWrites();
    const boom = new Error("disk full");
    await expect(write(() => Promise.reject(boom))).rejects.toThrow("disk full");
  });

  it("keeps the chain alive after a failed write", async () => {
    const write = serializeWrites();
    const after: number[] = [];
    const failing = write(() => Promise.reject(new Error("eperm")));
    const following = write(() => {
      after.push(1);
      return Promise.resolve();
    });
    await expect(failing).rejects.toThrow("eperm");
    await expect(following).resolves.toBeUndefined();
    expect(after).toEqual([1]);
  });
});

describe("writeJsonAtomic", () => {
  it("writes pretty JSON through a tmp file, creating dirs", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "torlink-atomic-"));
    try {
      const file = path.join(dir, "nested", "state.json");
      await writeJsonAtomic(file, { a: 1 });
      expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ a: 1 });
      await expect(fs.access(`${file}.tmp`)).rejects.toThrow(); // tmp renamed away
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("writeJsonAtomicSync", () => {
  it("writes the same shape synchronously, creating dirs", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "torlink-atomic-"));
    try {
      const file = path.join(dir, "nested", "state.json");
      writeJsonAtomicSync(file, [1, 2]);
      expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual([1, 2]);
      await expect(fs.access(`${file}.sync.tmp`)).rejects.toThrow();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("throws on a bad target instead of silently losing the write", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "torlink-atomic-"));
    try {
      // A regular file where a directory is needed: mkdir must fail and surface it.
      const blocker = path.join(dir, "blocker");
      await fs.writeFile(blocker, "x");
      expect(() => writeJsonAtomicSync(path.join(blocker, "state.json"), {})).toThrow();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
