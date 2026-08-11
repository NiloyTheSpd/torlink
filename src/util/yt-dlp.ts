import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface YtDlpResult {
  ok: boolean;
  message: string;
}

export interface YtDlpFormat {
  format_id: string;
  format?: string;
  format_note?: string;
  ext: string;
  width?: number;
  height?: number;
  tbr?: number;
  abr?: number;
  filesize?: number;
  filesize_approx?: number;
  acodec?: string;
  vcodec?: string;
}

export type YtDlpInfoResult =
  | {
      ok: true;
      title: string;
      thumbnail?: string;
      formats: YtDlpFormat[];
      isPlaylist?: boolean;
      playlistCount?: number;
    }
  | {
      ok: false;
      message: string;
    };

// The install-time postinstall (scripts/ensure-ytdlp.cjs) drops the official
// yt-dlp binary here, so `npx torlnk` downloads videos with nothing else to
// install. The walk reaches the package root from the dev layout
// (src/util -> ../..) and from the tsup bundle (dist -> ..).
function packageRoot(): string {
  let dir =
    typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    if (existsSync(resolve(dir, "package.json"))) return dir;
    dir = resolve(dir, "..");
  }
  return dir;
}

const BUNDLED_YTDLP = resolve(
  packageRoot(),
  "vendor",
  "yt-dlp",
  process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp",
);

// Resolution order: the bundled binary, then a system yt-dlp, then the
// python module under either interpreter name. The python candidates fix the
// original fallback, which spawned process.execPath (node) with -m yt_dlp
// and could never work.
function* ytDlpCandidates(): Generator<readonly [string, readonly string[]]> {
  if (existsSync(BUNDLED_YTDLP)) yield [BUNDLED_YTDLP, []];
  yield ["yt-dlp", []];
  yield ["python", ["-m", "yt_dlp"]];
  yield ["python3", ["-m", "yt_dlp"]];
}

type Outcome = { ok: boolean; message?: string };

// Runs the operation against each candidate until one succeeds. A candidate
// that exists but fails (non-ENOENT) stops the cascade, like the original.
async function runWithFallback<T extends Outcome>(
  baseArgs: string[],
  run: (cmd: string, args: string[]) => Promise<T>,
): Promise<T> {
  for (const [cmd, prefix] of ytDlpCandidates()) {
    const result = await run(cmd, [...prefix, ...baseArgs]);
    if (result.ok || result.message !== "yt-dlp was not found.") return result;
  }
  return { ok: false, message: "yt-dlp is not installed or unavailable." } as T;
}

export function extractUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const httpMatch = trimmed.match(/https?:\/\/[^\s"'<>]+/i);
  if (httpMatch) return httpMatch[0];
  if (/^www\.[^\s"'<>]+$/i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return null;
}

async function runYtDlp(cmd: string, args: string[]): Promise<YtDlpResult> {
  return new Promise((resolveResult) => {
    let proc;
    try {
      proc = spawn(cmd, args, { windowsHide: true, stdio: "ignore" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      resolveResult({ ok: false, message });
      return;
    }

    proc.once("error", (error) => {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        resolveResult({ ok: false, message: "yt-dlp was not found." });
      } else {
        resolveResult({ ok: false, message: err.message ?? "yt-dlp failed to start." });
      }
    });

    proc.once("close", (code) => {
      if (code === 0) {
        resolveResult({ ok: true, message: "yt-dlp finished successfully." });
      } else {
        resolveResult({ ok: false, message: `yt-dlp exited with code ${code}.` });
      }
    });
  });
}

async function runYtDlpJson(cmd: string, args: string[]): Promise<YtDlpInfoResult> {
  return new Promise((resolveResult) => {
    let proc;
    try {
      proc = spawn(cmd, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      resolveResult({ ok: false, message });
      return;
    }

    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    proc.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    proc.once("error", (error) => {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        resolveResult({ ok: false, message: "yt-dlp was not found." });
      } else {
        resolveResult({ ok: false, message: err.message ?? "yt-dlp failed to start." });
      }
    });

    proc.once("close", (code) => {
      if (code !== 0) {
        const message = stderr.trim() || `yt-dlp exited with code ${code}.`;
        resolveResult({ ok: false, message });
        return;
      }

      try {
        const info = JSON.parse(stdout) as {
          title?: string;
          thumbnail?: string;
          formats?: YtDlpFormat[];
          _type?: string;
          playlist_count?: number;
        };
        resolveResult({
          ok: true,
          title: info.title ?? "Untitled video",
          thumbnail: info.thumbnail,
          formats: Array.isArray(info.formats) ? info.formats : [],
          isPlaylist: info._type === "playlist",
          playlistCount: info.playlist_count,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        resolveResult({ ok: false, message: `yt-dlp json parse failed: ${message}` });
      }
    });
  });
}

export async function getVideoInfo(url: string): Promise<YtDlpInfoResult> {
  return runWithFallback(["-j", "--no-warnings", url], runYtDlpJson);
}

export async function downloadVideoUrl(
  url: string,
  dir: string,
  formatId?: string,
  audioMp3 = false,
): Promise<YtDlpResult> {
  const output = resolve(dir, "%(title)s.%(ext)s").replaceAll("\\", "/");
  const args = ["-o", output, "--no-warnings", "--no-progress"];
  if (audioMp3) {
    args.push("-x", "--audio-format", "mp3", "-f", "bestaudio");
  } else if (formatId) {
    args.push("-f", formatId);
  }
  args.push(url);

  return runWithFallback(args, runYtDlp);
}

export async function downloadPlaylistUrl(
  url: string,
  dir: string,
  formatId?: string,
  audioMp3 = false,
): Promise<YtDlpResult> {
  const output = resolve(dir, "%(playlist_title)s", "%(title)s.%(ext)s").replaceAll("\\", "/");
  const args = ["-o", output, "--no-warnings", "--no-progress"];
  if (audioMp3) {
    args.push("-x", "--audio-format", "mp3", "-f", "bestaudio");
  } else if (formatId) {
    args.push("-f", formatId);
  }
  args.push(url);

  return runWithFallback(args, runYtDlp);
}
