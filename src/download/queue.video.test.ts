import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, type Mock } from "vitest";
import { DownloadQueue } from "./queue";
import { reconcileQueue } from "./reconcile";
import type { VideoDownloadSpec } from "./types";
import type { YtDlpProgress } from "./ytdlp";

type FakeYtDlp = {
  add: Mock<(id: string, spec: VideoDownloadSpec, dir: string) => boolean>;
  stats: Mock<(id: string) => YtDlpProgress | null>;
  pause: Mock<(id: string) => void>;
  remove: Mock<(id: string) => void>;
  destroy: Mock<() => void>;
};

function fakeEngine(): FakeYtDlp {
  return {
    add: vi.fn(() => true),
    stats: vi.fn((): YtDlpProgress | null => null),
    pause: vi.fn(),
    remove: vi.fn(),
    destroy: vi.fn(),
  };
}

function queueWith(fake: FakeYtDlp, opts: { maxDownloads?: number } = {}): DownloadQueue {
  return new DownloadQueue({ ...opts, ytdlp: fake });
}

function running(over: Partial<YtDlpProgress> = {}): YtDlpProgress {
  return {
    status: "running",
    progress: 42,
    downloadedBytes: 420,
    totalBytes: 1000,
    speed: 100,
    eta: 58,
    ...over,
  };
}

const VIDEO_URL = "https://example.com/watch?v=abc";
const SPEC: VideoDownloadSpec = { url: VIDEO_URL, formatId: "22" };

async function tick(q: DownloadQueue): Promise<void> {
  await (q as unknown as { tick(): Promise<void> }).tick();
}

describe("DownloadQueue.addVideo", () => {
  it("adds a video item with a stable video: id, title name, and empty magnet", () => {
    const fake = fakeEngine();
    const q = queueWith(fake);
    try {
      const out = q.addVideo({ url: VIDEO_URL, name: "Big Buck Bunny", dir: "/tmp/dl", formatId: "22" });
      expect(out).toEqual({ added: true, name: "Big Buck Bunny" });
      const it = q.getItems()[0]!;
      expect(it).toMatchObject({
        id: `video:${VIDEO_URL}`,
        video: SPEC,
        magnet: "",
        dir: "/tmp/dl",
        status: "downloading",
        name: "Big Buck Bunny",
      });
      expect(fake.add).toHaveBeenCalledWith(`video:${VIDEO_URL}`, SPEC, "/tmp/dl");
    } finally {
      q.suspend();
    }
  });

  it("dedupes an already-active video and reports added:false", () => {
    const fake = fakeEngine();
    const q = queueWith(fake);
    try {
      q.addVideo({ url: VIDEO_URL, dir: "/tmp/dl" });
      const out = q.addVideo({ url: VIDEO_URL, dir: "/tmp/elsewhere" });
      expect(out.added).toBe(false);
      expect(q.getItems()).toHaveLength(1);
      expect(fake.add).toHaveBeenCalledTimes(1);
    } finally {
      q.suspend();
    }
  });

  it("queues the video when the cap is full, then starts it on a freed slot", async () => {
    const fake = fakeEngine();
    fake.stats.mockReturnValueOnce(running({ status: "complete", progress: 100 }));
    const q = queueWith(fake, { maxDownloads: 1 });
    try {
      q.addVideo({ url: "https://x.example/a", name: "a", dir: "/tmp" });
      q.addVideo({ url: "https://x.example/b", name: "b", dir: "/tmp" });
      const byId = new Map(q.getItems().map((it) => [it.id, it.status]));
      expect(byId.get("video:https://x.example/a")).toBe("downloading");
      expect(byId.get("video:https://x.example/b")).toBe("queued");
      expect(fake.add).toHaveBeenCalledTimes(1);

      await tick(q); // first completes → slot frees → second starts
      expect(q.getItems()).toHaveLength(1);
      expect(q.getItems()[0]!.status).toBe("downloading");
      expect(fake.add).toHaveBeenCalledTimes(2);
      expect(q.getHistory()[0]?.video?.url).toBe("https://x.example/a");
    } finally {
      q.suspend();
    }
  });

  it("fails the item with a readable message when yt-dlp is missing", () => {
    const fake = fakeEngine();
    fake.add.mockReturnValue(false);
    const q = queueWith(fake);
    try {
      q.addVideo({ url: VIDEO_URL, dir: "/tmp/dl" });
      expect(q.getItems()[0]?.status).toBe("failed");
      expect(q.getItems()[0]?.error).toContain("yt-dlp is not installed");
    } finally {
      q.suspend();
    }
  });
});

describe("DownloadQueue video item lifecycle", () => {
  it("copies live stats from the engine into the item, with no peer count", async () => {
    const fake = fakeEngine();
    fake.stats.mockReturnValue(running());
    const q = queueWith(fake);
    try {
      q.addVideo({ url: VIDEO_URL, dir: "/tmp/dl" });
      await tick(q);
      expect(q.getItems()[0]).toMatchObject({
        progress: 42,
        downloadedBytes: 420,
        totalBytes: 1000,
        speed: 100,
        peers: 0,
        eta: 58,
      });
    } finally {
      q.suspend();
    }
  });

  it("moves a completed video to history with url + video spec and never seeds it", async () => {
    const fake = fakeEngine();
    fake.stats.mockReturnValue(running({ status: "complete", progress: 100, downloadedBytes: 1000 }));
    const q = queueWith(fake);
    try {
      q.addVideo({ url: VIDEO_URL, name: "Bunny", dir: "/tmp/dl", formatId: "22", audioMp3: false });
      await tick(q);
      expect(q.getItems()).toHaveLength(0);
      expect(q.getHistory()[0]).toMatchObject({
        url: VIDEO_URL,
        video: { url: VIDEO_URL, formatId: "22" },
        magnet: "",
        name: "Bunny",
        sizeBytes: 1000,
      });
      expect(q.getSeeds()).toHaveLength(0);
      expect(q.seedingCount).toBe(0);
      expect(fake.remove).toHaveBeenCalledWith(`video:${VIDEO_URL}`);
    } finally {
      q.suspend();
    }
  });

  it("fails the item on an engine error with the engine's message", async () => {
    const fake = fakeEngine();
    fake.stats.mockReturnValue(running({ status: "error", error: "Video unavailable" }));
    const q = queueWith(fake);
    try {
      q.addVideo({ url: VIDEO_URL, dir: "/tmp/dl" });
      await tick(q);
      expect(q.getItems()[0]?.status).toBe("failed");
      expect(q.getItems()[0]?.error).toBe("Video unavailable");
    } finally {
      q.suspend();
    }
  });

  it("pause kills the process; resume spawns again (yt-dlp continues the .part); cancel removes", () => {
    const fake = fakeEngine();
    const q = queueWith(fake);
    try {
      q.addVideo({ url: VIDEO_URL, dir: "/tmp/dl" });
      const id = q.getItems()[0]!.id;

      q.pause(id);
      expect(q.getItems()[0]?.status).toBe("paused");
      expect(fake.pause).toHaveBeenCalledWith(id);

      q.resume(id);
      expect(q.getItems()[0]?.status).toBe("downloading");
      expect(fake.add).toHaveBeenCalledTimes(2); // fresh spawn resumes the partial

      q.cancel(id);
      expect(q.getItems()).toHaveLength(0);
      expect(fake.remove).toHaveBeenCalledWith(id);
    } finally {
      q.suspend();
    }
  });

  it("suspend destroys the yt-dlp engine", () => {
    const fake = fakeEngine();
    const q = queueWith(fake);
    q.addVideo({ url: VIDEO_URL, dir: "/tmp/dl" });
    q.suspend();
    expect(fake.destroy).toHaveBeenCalled();
  });

  it("restore re-spawns in-flight video items and keeps paused/failed as saved", () => {
    const fake = fakeEngine();
    const q = queueWith(fake);
    try {
      q.addVideo({ url: VIDEO_URL, dir: "/tmp/dl" });
      const base = q.getItems()[0]!;
      q.pause(base.id);
      const paused = q.getItems()[0]!;

      const failed = { ...paused, id: "video:https://f.example/x", video: { url: "https://f.example/x" }, name: "x", status: "failed" as const, error: "old" };
      q.restore(reconcileQueue([paused, failed]));
      expect(fake.add).toHaveBeenCalledTimes(1); // paused/failed never touch the engine
      expect(q.getItems()[1]?.status).toBe("failed");

      q.restore(reconcileQueue([{ ...base, status: "downloading" }]));
      expect(fake.add).toHaveBeenCalledTimes(2);
      expect(fake.add).toHaveBeenLastCalledWith(`video:${VIDEO_URL}`, paused.video, "/tmp/dl");
    } finally {
      q.suspend();
    }
  });
});

describe("DownloadQueue video persistence round-trip", () => {
  it("video items survive save -> load -> restore with the spec intact", async () => {
    // Isolated state dir + fresh module instances (the paths module reads
    // TORLINK_STATE_DIR at import time) so this never touches real user data.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "torlink-video-persist-"));
    vi.stubEnv("TORLINK_STATE_DIR", dir);
    vi.resetModules();
    const { DownloadQueue: IsolatedQueue } = await import("./queue");
    const { loadQueue } = await import("./persist");
    try {
      const first = fakeEngine();
      const q1 = new IsolatedQueue({ ytdlp: first });
      q1.addVideo({ url: VIDEO_URL, name: "Bunny", dir: "/tmp/dl", formatId: "22", isPlaylist: true });
      q1.suspend(); // flushes queue.json synchronously, zeroes live stats

      const second = fakeEngine();
      const q2 = new IsolatedQueue({ ytdlp: second });
      q2.restore(await loadQueue());
      expect(second.add).toHaveBeenCalledWith(`video:${VIDEO_URL}`, { ...SPEC, isPlaylist: true }, "/tmp/dl");
      const it = q2.getItems()[0];
      expect(it).toMatchObject({
        id: `video:${VIDEO_URL}`,
        video: { url: VIDEO_URL, formatId: "22", isPlaylist: true },
        magnet: "",
        status: "downloading",
        name: "Bunny",
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
