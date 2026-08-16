import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const expectedOutput = (template: string): string => resolve(template).replaceAll("\\", "/");

const spawn = vi.fn();
vi.mock("node:child_process", () => ({ spawn }));

// The bundled yt-dlp binary (vendor/) only exists when the postinstall ran;
// tests default to its absence so the resolution order is deterministic.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: vi.fn(() => false) };
});
const mockExists = vi.mocked(existsSync);

type FakeProc = EventEmitter & { kill: () => void };

type FakeErrorProc = FakeProc & { emitError: (err: Error) => void };

function fakeProc(code: number): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  proc.kill = vi.fn();
  queueMicrotask(() => proc.emit("close", code));
  return proc;
}

function fakeErrorProc(code: string): FakeErrorProc {
  const proc = new EventEmitter() as FakeErrorProc;
  proc.kill = vi.fn();
  const err = new Error(`spawn yt-dlp ${code}`) as NodeJS.ErrnoException;
  err.code = code;
  proc.emitError = () => queueMicrotask(() => proc.emit("error", err));
  return proc;
}

describe("extractUrl", () => {
  beforeEach(() => {
    spawn.mockReset();
  });

  it("returns the first HTTP URL in a string", async () => {
    const { extractUrl } = await import("./yt-dlp");
    expect(extractUrl("video https://example.com/watch?v=1 something")).toBe(
      "https://example.com/watch?v=1",
    );
  });

  it("returns HTTPS url from bare www host", async () => {
    const { extractUrl } = await import("./yt-dlp");
    expect(extractUrl("www.youtube.com/watch?v=1")).toBe("https://www.youtube.com/watch?v=1");
  });

  it("returns null for non-url input", async () => {
    const { extractUrl } = await import("./yt-dlp");
    expect(extractUrl("not a url")).toBeNull();
  });
});

describe("downloadVideoUrl", () => {
  beforeEach(() => {
    spawn.mockReset();
    mockExists.mockImplementation(() => false);
  });
  it("tries yt-dlp first and succeeds when yt-dlp resolves", async () => {
    const { downloadVideoUrl } = await import("./yt-dlp");
    spawn.mockImplementation(() => fakeProc(0));

    const result = await downloadVideoUrl("https://example.com/video", "/tmp");

    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/finished successfully/);
    expect(spawn).toHaveBeenCalledWith(
      "yt-dlp",
      ["-o", expectedOutput("/tmp/%(title)s.%(ext)s"), "--no-warnings", "--no-progress", "https://example.com/video"],
      { windowsHide: true, stdio: "ignore" },
    );
  });

  it("falls back to the python module when yt-dlp is unavailable", async () => {
    const { downloadVideoUrl } = await import("./yt-dlp");
    let call = 0;
    spawn.mockImplementation((cmd: string) => {
      call += 1;
      if (call === 1) {
        const proc = fakeErrorProc("ENOENT");
        proc.emitError(new Error("spawn yt-dlp ENOENT"));
        return proc;
      }
      return fakeProc(0);
    });

    const result = await downloadVideoUrl("https://example.com/video", "/tmp");

    expect(result.ok).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[0]?.[0]).toBe("yt-dlp");
    expect(spawn.mock.calls[1]?.[0]).toBe("python");
    expect(spawn.mock.calls[1]?.[1]).toEqual(["-m", "yt_dlp", "-o", expectedOutput("/tmp/%(title)s.%(ext)s"), "--no-warnings", "--no-progress", "https://example.com/video"]);
    expect(result.message).toMatch(/finished successfully/);
  });

  it("prefers the bundled yt-dlp binary when the postinstall shipped one", async () => {
    const { downloadVideoUrl } = await import("./yt-dlp");
    mockExists.mockImplementation((p) => String(p).includes("vendor"));
    spawn.mockImplementation(() => fakeProc(0));

    const result = await downloadVideoUrl("https://example.com/video", "/tmp");

    expect(result.ok).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
    const cmd = spawn.mock.calls[0]?.[0] as string;
    expect(cmd).toContain("vendor");
    expect(cmd).toMatch(/yt-dlp(\.exe)?$/);
    expect(spawn.mock.calls[0]?.[1]).toEqual(["-o", expectedOutput("/tmp/%(title)s.%(ext)s"), "--no-warnings", "--no-progress", "https://example.com/video"]);
  });

  it("returns an error when yt-dlp and python module both fail", async () => {
    const { downloadVideoUrl } = await import("./yt-dlp");
    spawn.mockImplementation(() => fakeProc(1));

    const result = await downloadVideoUrl("https://example.com/video", "/tmp");

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not installed or unavailable|yt-dlp exited with code 1/);
  });
});

describe("downloadPlaylistUrl", () => {
  beforeEach(() => {
    spawn.mockReset();
    mockExists.mockImplementation(() => false);
  });

  it("organizes playlist downloads into a playlist-named folder", async () => {
    const { downloadPlaylistUrl } = await import("./yt-dlp");
    spawn.mockImplementation(() => fakeProc(0));

    const result = await downloadPlaylistUrl("https://example.com/playlist", "/tmp");

    expect(result.ok).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(
      "yt-dlp",
      [
        "-o",
        expectedOutput("/tmp/%(playlist_title)s/%(title)s.%(ext)s"),
        "--no-warnings",
        "--no-progress",
        "https://example.com/playlist",
      ],
      { windowsHide: true, stdio: "ignore" },
    );
  });

  it("requests mp3 audio when audioMp3 is set", async () => {
    const { downloadPlaylistUrl } = await import("./yt-dlp");
    spawn.mockImplementation(() => fakeProc(0));

    await downloadPlaylistUrl("https://example.com/playlist", "/tmp", undefined, true);

    expect(spawn.mock.calls[0]?.[1]).toEqual([
      "-o",
      expectedOutput("/tmp/%(playlist_title)s/%(title)s.%(ext)s"),
      "--no-warnings",
      "--no-progress",
      "-x",
      "--audio-format",
      "mp3",
      "-f",
      "bestaudio/best",
      "https://example.com/playlist",
    ]);
  });
});
