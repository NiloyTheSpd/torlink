import { promises as fs } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { deleteSeedData } from "./delete-data";

// The mock only replaces the "node:fs/promises" specifier (what delete-data
// imports); the test's own fs helpers use the "node:fs" namespace and keep
// real behavior. rm's real behavior stays active except where a test forces
// a rejection: on Windows a locked or permission-denied file can't be
// reproduced reliably in-process, so the failure branch is mocked.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

const mockRm = vi.mocked(rm);

beforeEach(() => {
  mockRm.mockClear();
});

describe("deleteSeedData", () => {
  it("deletes a downloaded folder under the dir and reports its path", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "torlink-del-"));
    try {
      const target = path.join(dir, "Some Release");
      await fs.mkdir(target);
      await fs.writeFile(path.join(target, "file.bin"), "data");

      await expect(deleteSeedData(dir, "Some Release")).resolves.toBe(target);
      await expect(fs.access(target)).rejects.toThrow();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("deletes a single downloaded file and reports its path", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "torlink-del-"));
    try {
      const target = path.join(dir, "movie.mkv");
      await fs.writeFile(target, "data");
      await expect(deleteSeedData(dir, "movie.mkv")).resolves.toBe(target);
      await expect(fs.access(target)).rejects.toThrow();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("treats an already-gone target as deleted (force semantics)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "torlink-del-"));
    try {
      await expect(deleteSeedData(dir, "never-existed")).resolves.toBe(
        path.join(dir, "never-existed"),
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("returns null — not the path — when the rm itself fails", async () => {
    const eperm = Object.assign(new Error("file in use"), { code: "EPERM" });
    mockRm.mockRejectedValueOnce(eperm);
    await expect(deleteSeedData("D:/dl", "still-locked.mkv")).resolves.toBeNull();
  });

  it("refuses names that could escape the download dir", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "torlink-del-"));
    try {
      await expect(deleteSeedData(dir, "")).resolves.toBeNull();
      await expect(deleteSeedData(dir, ".")).resolves.toBeNull();
      await expect(deleteSeedData(dir, "..")).resolves.toBeNull();
      await expect(deleteSeedData(dir, "   ")).resolves.toBeNull();
      // A path is folded to its basename: only the entry inside dir is targeted.
      await expect(deleteSeedData(dir, path.join("..", "elsewhere"))).resolves.toBe(
        path.join(dir, "elsewhere"),
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
