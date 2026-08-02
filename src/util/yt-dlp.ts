import { spawn } from "node:child_process";
import { resolve } from "node:path";

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
  const args = ["-j", "--no-warnings", url];

  let result = await runYtDlpJson("yt-dlp", args);
  if (result.ok) return result;

  if (result.message === "yt-dlp was not found.") {
    result = await runYtDlpJson(process.execPath, ["-m", "yt_dlp", ...args]);
    if (result.ok) {
      return result;
    }
    return { ok: false, message: "yt-dlp is not installed or unavailable." };
  }

  return result;
}

export async function downloadVideoUrl(
  url: string,
  dir: string,
  formatId?: string,
  audioMp3 = false,
): Promise<YtDlpResult> {
  const output = resolve(dir, "%(title)s.%(ext)s");
  const args = ["-o", output, "--no-warnings", "--no-progress"];
  if (audioMp3) {
    args.push("-x", "--audio-format", "mp3", "-f", "bestaudio");
  } else if (formatId) {
    args.push("-f", formatId);
  }
  args.push(url);

  let result = await runYtDlp("yt-dlp", args);
  if (result.ok) return result;

  if (result.message === "yt-dlp was not found.") {
    result = await runYtDlp(process.execPath, ["-m", "yt_dlp", ...args]);
    if (result.ok) {
      return result;
    }
    return { ok: false, message: "yt-dlp is not installed or unavailable." };
  }

  return result;
}

export async function downloadPlaylistUrl(
  url: string,
  dir: string,
  formatId?: string,
  audioMp3 = false,
): Promise<YtDlpResult> {
  const output = resolve(dir, "%(playlist_title)s", "%(title)s.%(ext)s");
  const args = ["-o", output, "--no-warnings", "--no-progress"];
  if (audioMp3) {
    args.push("-x", "--audio-format", "mp3", "-f", "bestaudio");
  } else if (formatId) {
    args.push("-f", formatId);
  }
  args.push(url);

  let result = await runYtDlp("yt-dlp", args);
  if (result.ok) return result;

  if (result.message === "yt-dlp was not found.") {
    result = await runYtDlp(process.execPath, ["-m", "yt_dlp", ...args]);
    if (result.ok) {
      return result;
    }
    return { ok: false, message: "yt-dlp is not installed or unavailable." };
  }

  return result;
}
