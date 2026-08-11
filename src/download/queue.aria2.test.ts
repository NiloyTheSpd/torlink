import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, type Mock } from "vitest";
import { DownloadQueue } from "./queue";
import { reconcileQueue } from "./reconcile";
import type { Aria2Status } from "./aria2";

type FakeAria2 = {
  add: Mock<(url: string, dir: string) => Promise<string>>;
  stats: Mock<(gid: string) => Promise<Aria2Status | null>>;
  pause: Mock<(gid: string) => Promise<void>>;
  unpause: Mock<(gid: string) => Promise<void>>;
  remove: Mock<(gid: string) => Promise<void>>;
  destroy: Mock<() => Promise<void>>;
};

function fakeEngine(): FakeAria2 {
  let n = 0;
  return {
    add: vi.fn<(url: string, dir: string) => Promise<string>>(async () => `gid-${++n}`),
    stats: vi.fn<(gid: string) => Promise<Aria2Status | null>>(async () => null),
    pause: vi.fn<(gid: string) => Promise<void>>(async () => {}),
    unpause: vi.fn<(gid: string) => Promise<void>>(async () => {}),
    remove: vi.fn<(gid: string) => Promise<void>>(async () => {}),
    destroy: vi.fn<() => Promise<void>>(async () => {}),
  };
}

function queueWith(fake: FakeAria2, opts: { maxDownloads?: number } = {}): DownloadQueue {
  return new DownloadQueue({ ...opts, aria2: fake });
}

function activeStatus(over: Partial<Aria2Status> = {}): Aria2Status {
  return {
    status: "active",
    progress: 42,
    downloaded: 420,
    total: 1000,
    speed: 100,
    connections: 8,
    timeRemaining: 5800,
    name: "file.bin",
    ...over,
  };
}

const URL = "https://example.com/dist/file.bin";

async function tick(q: DownloadQueue): Promise<void> {
  await (q as unknown as { tick(): Promise<void> }).tick();
}

describe("DownloadQueue.addUrl", () => {
  it("adds a url item with a stable url: id, derived name, and empty magnet", async () => {
    const fake = fakeEngine();
    const q = queueWith(fake);
    try {
      const out = await q.addUrl(URL, "/tmp/dl");
      expect(out).toEqual({ added: true, name: "file.bin" });
      const it = q.getItems()[0]!;
      expect(it).toMatchObject({
        id: `url:${URL}`,
        url: URL,
        magnet: "",
        dir: "/tmp/dl",
        status: "downloading",
        name: "file.bin",
      });
      expect(fake.add).toHaveBeenCalledWith(URL, "/tmp/dl");
    } finally {
      q.suspend();
    }
  });

  it("dedupes an already-active url and reports added:false", async () => {
    const fake = fakeEngine();
    const q = queueWith(fake);
    try {
      await q.addUrl(URL, "/tmp/dl");
      const out = await q.addUrl(URL, "/tmp/elsewhere");
      expect(out.added).toBe(false);
      expect(q.getItems()).toHaveLength(1);
      expect(fake.add).toHaveBeenCalledTimes(1);
    } finally {
      q.suspend();
    }
  });

  it("queues the url item when the download cap is full, then starts it on a freed slot", async () => {
    const fake = fakeEngine();
    fake.stats.mockResolvedValueOnce(
      activeStatus({ status: "complete", progress: 100, downloaded: 1000 }),
    );
    const q = queueWith(fake, { maxDownloads: 1 });
    try {
      await q.addUrl("https://a.example/one.bin", "/tmp");
      await q.addUrl("https://b.example/two.bin", "/tmp");
      expect(q.getItems()[0]!.status).toBe("downloading");
      expect(q.getItems()[1]!.status).toBe("queued");
      expect(fake.add).toHaveBeenCalledTimes(1);

      await tick(q); // first completes → slot frees → second starts
      expect(q.getItems()).toHaveLength(1);
      expect(q.getItems()[0]!.status).toBe("downloading");
      expect(fake.add).toHaveBeenCalledTimes(2);
      expect(q.getHistory()[0]?.url).toBe("https://a.example/one.bin");
    } finally {
      q.suspend();
    }
  });

  it("fails the item with a readable message when the engine cannot add it", async () => {
    const fake = fakeEngine();
    fake.add.mockRejectedValueOnce(new Error("aria2 unreachable: boom"));
    const q = queueWith(fake);
    try {
      await q.addUrl(URL, "/tmp/dl");
      // The async start settles on its own; wait for the failure to land.
      await vi.waitFor(() => {
        expect(q.getItems()[0]?.status).toBe("failed");
      });
      expect(q.getItems()[0]?.error).toContain("boom");
    } finally {
      q.suspend();
    }
  });
});

describe("DownloadQueue url item lifecycle", () => {
  it("copies live stats from aria2 into the item", async () => {
    const fake = fakeEngine();
    fake.stats.mockResolvedValue(activeStatus());
    const q = queueWith(fake);
    try {
      await q.addUrl(URL, "/tmp/dl");
      await tick(q);
      const it = q.getItems()[0]!;
      expect(it).toMatchObject({
        progress: 42,
        downloadedBytes: 420,
        totalBytes: 1000,
        speed: 100,
        peers: 8,
        name: "file.bin",
      });
      expect(it.eta).toBeCloseTo(5.8, 1);
    } finally {
      q.suspend();
    }
  });

  it("moves a completed url item to history with url preserved and never seeds it", async () => {
    const fake = fakeEngine();
    fake.stats.mockResolvedValue(
      activeStatus({ status: "complete", progress: 100, downloaded: 1000 }),
    );
    const q = queueWith(fake);
    try {
      await q.addUrl(URL, "/tmp/dl");
      await tick(q);
      expect(q.getItems()).toHaveLength(0);
      const h = q.getHistory()[0];
      expect(h).toMatchObject({ url: URL, magnet: "", name: "file.bin", dir: "/tmp/dl" });
      expect(q.getSeeds()).toHaveLength(0);
      expect(q.seedingCount).toBe(0);
      // Completed gid is cleaned out of aria2's stopped list.
      expect(fake.remove).toHaveBeenCalledWith("gid-1");
    } finally {
      q.suspend();
    }
  });

  it("fails the item on an aria2 error status with the engine message", async () => {
    const fake = fakeEngine();
    fake.stats.mockResolvedValue(activeStatus({ status: "error", errorMessage: "URI not found" }));
    const q = queueWith(fake);
    try {
      await q.addUrl(URL, "/tmp/dl");
      await tick(q);
      expect(q.getItems()[0]?.status).toBe("failed");
      expect(q.getItems()[0]?.error).toBe("URI not found");
    } finally {
      q.suspend();
    }
  });

  it("retry re-adds a failed url item (aria2 resumes the partial file)", async () => {
    const fake = fakeEngine();
    fake.stats.mockResolvedValue(activeStatus({ status: "error", errorMessage: "nope" }));
    const q = queueWith(fake);
    try {
      await q.addUrl(URL, "/tmp/dl");
      await tick(q);
      expect(q.getItems()[0]?.status).toBe("failed");
      fake.stats.mockResolvedValue(activeStatus());
      q.retry(q.getItems()[0]!.id);
      await vi.waitFor(() => {
        expect(fake.add).toHaveBeenCalledTimes(2);
      });
      expect(q.getItems()[0]?.status).toBe("downloading");
    } finally {
      q.suspend();
    }
  });

  it("pause pauses via rpc and resume unpauses; cancel removes via rpc", async () => {
    const fake = fakeEngine();
    const q = queueWith(fake);
    try {
      await q.addUrl(URL, "/tmp/dl");
      q.pause(q.getItems()[0]!.id);
      expect(q.getItems()[0]?.status).toBe("paused");
      expect(fake.pause).toHaveBeenCalledWith("gid-1");

      q.resume(q.getItems()[0]!.id);
      expect(q.getItems()[0]?.status).toBe("downloading");
      expect(fake.unpause).toHaveBeenCalledWith("gid-1");

      q.cancel(q.getItems()[0]!.id);
      expect(q.getItems()).toHaveLength(0);
      expect(fake.remove).toHaveBeenCalledWith("gid-1");
    } finally {
      q.suspend();
    }
  });

  it("remove with deleteFiles deletes the downloaded file", async () => {
    const fake = fakeEngine();
    const q = queueWith(fake);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "torlink-aria2-remove-"));
    try {
      await q.addUrl(URL, dir);
      await fs.writeFile(path.join(dir, "file.bin"), "data");
      const ok = await q.remove(q.getItems()[0]!.id, { deleteFiles: true });
      expect(ok).toBe(true);
      await expect(fs.access(path.join(dir, "file.bin"))).rejects.toThrow();
      expect(fake.remove).toHaveBeenCalledWith("gid-1");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
      q.suspend();
    }
  });

  it("restore re-adds in-flight url items and keeps paused/failed as saved", async () => {
    const fake = fakeEngine();
    fake.stats.mockResolvedValue(activeStatus());
    const q = queueWith(fake);
    try {
      await q.addUrl(URL, "/tmp/dl");
      const it = q.getItems()[0]!;
      q.pause(it.id);
      const paused = q.getItems()[0]!;

      const failed: typeof paused = {
        ...paused,
        id: "url:https://f.example/x.bin",
        url: "https://f.example/x.bin",
        name: "x.bin",
        status: "failed",
        error: "old error",
      };
      q.restore(reconcileQueue([paused, failed]));
      expect(q.getItems()[0]?.status).toBe("paused");
      expect(q.getItems()[1]?.status).toBe("failed");
      // Paused/failed items never touch the engine; only the original addUrl did.
      expect(fake.add).toHaveBeenCalledTimes(1);

      const restored: typeof paused = { ...paused, id: `url:${URL}`, url: URL, status: "downloading" };
      q.restore(reconcileQueue([restored]));
      await vi.waitFor(() => {
        expect(fake.add).toHaveBeenCalledTimes(2);
      });
      expect(fake.add).toHaveBeenLastCalledWith(URL, "/tmp/dl");
    } finally {
      q.suspend();
    }
  });

  it("suspend destroys the aria2 engine", async () => {
    const fake = fakeEngine();
    const q = queueWith(fake);
    await q.addUrl(URL, "/tmp/dl");
    q.suspend();
    expect(fake.destroy).toHaveBeenCalled();
  });
});

describe("DownloadQueue url persistence round-trip", () => {
  it("url items survive save -> load -> restore with the url intact", async () => {
    // Isolated state dir + fresh module instances (the paths module reads
    // TORLINK_STATE_DIR at import time) so this never touches the shared
    // test-state dir or the real user data.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "torlink-aria2-persist-"));
    vi.stubEnv("TORLINK_STATE_DIR", dir);
    vi.resetModules();
    const { DownloadQueue: IsolatedQueue } = await import("./queue");
    const { loadQueue } = await import("./persist");
    try {
      const first = fakeEngine();
      const q1 = new IsolatedQueue({ aria2: first });
      await q1.addUrl(URL, "/tmp/dl");
      q1.suspend(); // flushes queue.json synchronously, zeroes live stats

      const second = fakeEngine();
      const q2 = new IsolatedQueue({ aria2: second });
      q2.restore(await loadQueue());
      await vi.waitFor(() => {
        expect(second.add).toHaveBeenCalledWith(URL, "/tmp/dl");
      });
      const it = q2.getItems()[0];
      expect(it).toMatchObject({
        id: `url:${URL}`,
        url: URL,
        magnet: "",
        status: "downloading",
        name: "file.bin",
        dir: "/tmp/dl",
      });
      q2.suspend();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
