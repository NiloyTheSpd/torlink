// Full-app integration: a video item persisted in queue.json renders as a
// first-class row in the Downloads view after a real boot + real keystroke
// navigation. Proves the yt-dlp queue UI is reachable end-to-end, not just in
// component isolation.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderUI, stripAnsi, type RenderedUI } from "./testHarness";

const VIDEO_URL = "https://example.com/watch?v=abc";

// The paste-a-URL flow needs video info (network) and a running engine; both
// are faked so the test drives only torlnk's own wiring.
vi.mock("../util/yt-dlp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../util/yt-dlp")>();
  return {
    ...actual,
    getVideoInfo: vi.fn(async () => ({
      ok: true as const,
      title: "Big Buck Bunny 1080p",
      formats: [],
    })),
  };
});

vi.mock("../download/ytdlp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../download/ytdlp")>();
  return {
    ...actual,
    YtDlpEngine: class {
      add(): boolean {
        return true;
      }
      stats() {
        return {
          status: "running" as const,
          progress: 42,
          downloadedBytes: 420,
          totalBytes: 1000,
          speed: 100,
          eta: 58,
        };
      }
      pause(): void {}
      remove(): void {}
      destroy(): void {}
    },
  };
});

async function seedVideoItem(withItem: boolean): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "torlink-app-video-"));
  // paths.ts reads TORLINK_STATE_DIR at import time; it must be set before
  // App's module graph loads, hence the dynamic import below.
  vi.stubEnv("TORLINK_STATE_DIR", dir);
  vi.resetModules();
  await fs.mkdir(path.join(dir, "data"), { recursive: true });
  if (withItem) {
    await fs.writeFile(
      path.join(dir, "data", "queue.json"),
      JSON.stringify([
        {
          id: `video:${VIDEO_URL}`,
          name: "Big Buck Bunny 1080p",
          magnet: "",
          video: { url: VIDEO_URL, formatId: "22" },
          dir: "C:/dl",
          // Paused so boot restores it without spawning yt-dlp.
          status: "paused",
          progress: 40,
          totalBytes: 0,
          downloadedBytes: 0,
          speed: 0,
          peers: 0,
          addedAt: 1_760_000_000_000,
        },
      ]),
      "utf8",
    );
  }
  return dir;
}

let ui: RenderedUI | null = null;
afterEach(() => {
  ui?.unmount();
  ui = null;
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("App video downloads UI", () => {
  it("shows a restored video item in the Downloads view with a vid tag", async () => {
    const dir = await seedVideoItem(true);
    const { App } = await import("./App");
    try {
      ui = renderUI(<App />);
      const u = ui;

      // Boot settles into the splash (a search prompt); enter opens the browser.
      await vi.waitFor(
        () => {
          expect(u.frame()).toContain("terminal-native torrent downloader");
        },
        { timeout: 5000 },
      );
      const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 25));
      u.press("\r");
      await vi.waitFor(() => {
        expect(u.frame()).toContain("Downloads");
      });

      // tab moves focus to the sidebar, then j×6 walks All→…→Downloads.
      u.press("\t");
      await tick();
      for (let i = 0; i < 6; i++) {
        u.press("j");
        await tick();
      }
      // Back to the content region so the Downloads panel is in focus.
      u.press("\t");
      await tick();

      await vi.waitFor(() => {
        const frame = stripAnsi(u.frame());
        expect(frame).toContain("Big Buck Bunny 1080p");
      });
      const frame = stripAnsi(u.frame());
      const line = frame.split("\n").find((l) => l.includes("Big Buck Bunny")) ?? "";
      expect(line).toContain("vid");
      expect(line).not.toContain("mag");
      expect(frame).toContain("paused  40%");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("pasting a video URL queues it and jumps to the Downloads view with live progress", async () => {
    const dir = await seedVideoItem(false);
    // seedVideoItem already stubbed the env and reset modules; the mocks
    // above re-apply on the fresh module graph.
    const { App } = await import("./App");
    try {
      const u = renderUI(<App />);
      await vi.waitFor(() => {
        expect(u.frame()).toContain("terminal-native torrent downloader");
      });
      const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 25));

      // Type a page URL into the splash search bar and submit it.
      for (const ch of VIDEO_URL) {
        u.press(ch);
        await tick();
      }
      u.press("\r");
      await vi.waitFor(() => {
        expect(u.frame().toLowerCase()).toContain("pick a format");
      });
      // Settle so this enter is not coalesced into the same input chunk as
      // the submit (Ink merges immediate stdin writes into one keypress).
      await tick();

      // Enter accepts the highlighted quality; the app should land on the
      // Downloads view with the new video row already downloading.
      u.press("\r");
      await vi.waitFor(() => {
        const frame = stripAnsi(u.frame());
        expect(frame).toContain("Big Buck Bunny 1080p");
        expect(frame).toContain("vid");
      });
      await vi.waitFor(
        () => {
          expect(stripAnsi(u.frame())).toContain("42%");
        },
        { timeout: 3000 },
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
