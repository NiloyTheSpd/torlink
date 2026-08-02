import { spawn } from "node:child_process";
import { resolve } from "node:path";

export interface YtDlpResult {
  ok: boolean;
  message: string;
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

export async function downloadVideoUrl(url: string, dir: string): Promise<YtDlpResult> {
  const output = resolve(dir, "%(title)s.%(ext)s");
  const args = ["-o", output, "--no-warnings", "--no-progress", url];

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
