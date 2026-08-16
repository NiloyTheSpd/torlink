// yt-dlp media downloads: a process-per-download engine that spawns yt-dlp
// with --newline and parses its progress lines into the same shape the queue
// already consumes from aria2. yt-dlp resumes partial .part files on restart
// (--continue is on by default), so pause kills the process and resume simply
// spawns it again.

import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { parseSize } from "../util/format";
import { ytDlpCandidates } from "../util/yt-dlp";
import type { VideoDownloadSpec } from "./types";

export interface YtDlpProgress {
  status: "running" | "complete" | "error";
  progress: number;
  downloadedBytes: number;
  totalBytes: number;
  speed: number; // bytes/sec
  eta?: number; // seconds
  error?: string;
}

// What the engine needs from a spawned process. Structural (and stdin-less)
// so both a real spawn and a test fake satisfy it without casts.
export interface YtDlpProcess {
  stdout: Readable;
  stderr: Readable;
  kill(): void;
  once(event: "error", listener: (err: Error) => void): unknown;
  once(event: "close", listener: (code: number | null, signal: string | null) => void): unknown;
}

export type YtDlpSpawnFn = (cmd: string, args: string[], opts: { windowsHide: boolean }) => YtDlpProcess;

// One line of yt-dlp --newline output. `playlist` tracks "item i of n" so a
// multi-file download shows honest overall progress instead of cycling 0-100%.
export function parseYtDlpLine(
  line: string,
  playlist?: { item: number; count: number },
): {
  kind: "progress" | "item";
  progress?: number; // 0-100 overall
  totalBytes?: number;
  speed?: number;
  eta?: number;
  item?: number;
  count?: number;
} | null {
  const itemMatch = line.match(/^\[download\] Downloading item (\d+) of (\d+)/);
  if (itemMatch) {
    return { kind: "item", item: Number(itemMatch[1]), count: Number(itemMatch[2]) };
  }

  const m = line.match(/^\[download\]\s+(\d+(?:\.\d+)?)% of\s+(?:~)?([\d.]+\s*[KMGT]?I?B)/i);
  if (!m) return null;

  const frac = Math.min(100, parseFloat(m[1]!));
  const totalBytes = parseSize(m[2]!);
  let progress = frac;
  if (playlist && playlist.count > 0) {
    progress = ((playlist.item - 1 + frac / 100) / playlist.count) * 100;
  }

  let speed: number | undefined;
  const speedMatch = line.match(/at\s+([\d.]+\s*[KMGT]?I?B)\/s/i);
  if (speedMatch) speed = parseSize(speedMatch[1]!);

  let eta: number | undefined;
  const etaMatch = line.match(/ETA\s+(\d+):(\d{2})(?::(\d{2}))?/);
  if (etaMatch) {
    const a = Number(etaMatch[1]);
    const b = Number(etaMatch[2]);
    const c = etaMatch[3] ? Number(etaMatch[3]) : null;
    eta = c === null ? a * 60 + b : a * 3600 + b * 60 + c;
  }

  return { kind: "progress", progress: Math.round(progress * 10) / 10, totalBytes, speed, eta };
}

interface ProcState {
  proc: YtDlpProcess;
  progress: YtDlpProgress;
  playlist: { item: number; count: number };
  lastError: string | null;
}

/**
 * Owns one spawned yt-dlp process per queue item. `add` returns false when no
 * yt-dlp binary can be found (the queue turns that into a readable failed
 * item). All methods are synchronous: progress arrives through parsed stdout
 * and is read by the queue's poll via `stats`.
 */
export class YtDlpEngine {
  private readonly spawnImpl: YtDlpSpawnFn;
  private readonly procs = new Map<string, ProcState>();

  constructor(opts: { spawnImpl?: YtDlpSpawnFn } = {}) {
    this.spawnImpl =
      opts.spawnImpl ??
      ((cmd, args, spawnOpts) =>
        spawn(cmd, args, {
          windowsHide: spawnOpts.windowsHide,
          stdio: ["ignore", "pipe", "pipe"],
        }) as unknown as YtDlpProcess);
  }

  private buildArgs(spec: VideoDownloadSpec, dir: string): string[] {
    const base = dir.replaceAll("\\", "/");
    const output = spec.isPlaylist
      ? `${base}/%(playlist_title)s/%(title)s.%(ext)s`
      : `${base}/%(title)s.%(ext)s`;
    const args = ["-o", output, "--newline", "--no-warnings"];
    if (spec.audioMp3) {
      // bestaudio/best: a video with no separate audio stream must still
      // convert instead of failing the format match.
      args.push("-x", "--audio-format", "mp3", "-f", "bestaudio/best");
    } else if (spec.formatId) {
      args.push("-f", spec.formatId);
    }
    args.push(spec.url);
    return args;
  }

  /** Start a download. Returns false when yt-dlp is not installed at all. */
  add(id: string, spec: VideoDownloadSpec, dir: string): boolean {
    if (this.procs.has(id)) return true; // already running
    const state: ProcState = {
      proc: null as unknown as YtDlpProcess,
      progress: {
        status: "running",
        progress: 0,
        downloadedBytes: 0,
        totalBytes: 0,
        speed: 0,
      },
      playlist: { item: 1, count: 1 },
      lastError: null,
    };

    let launched = false;
    for (const [cmd, prefix] of ytDlpCandidates()) {
      let proc: YtDlpProcess;
      try {
        proc = this.spawnImpl(cmd, [...prefix, ...this.buildArgs(spec, dir)], {
          windowsHide: true,
        });
      } catch {
        continue; // spawn threw synchronously (bad executable path)
      }
      launched = true;
      state.proc = proc;
      this.procs.set(id, state);
      this.wire(id, state, proc);
      break;
    }
    return launched;
  }

  private wire(id: string, state: ProcState, proc: YtDlpProcess): void {
    const onLine = (raw: string): void => {
      for (const line of raw.split(/\r?\n/)) {
        const parsed = parseYtDlpLine(line, state.playlist);
        if (!parsed) continue;
        if (parsed.kind === "item") {
          if (parsed.count && parsed.item) {
            state.playlist = { item: parsed.item, count: parsed.count };
          }
          continue;
        }
        if (parsed.progress === undefined) continue;
        state.progress.progress = parsed.progress;
        if (parsed.totalBytes) {
          state.progress.totalBytes = parsed.totalBytes;
          state.progress.downloadedBytes = Math.round(
            (parsed.progress / 100) * parsed.totalBytes,
          );
        }
        state.progress.speed = parsed.speed ?? 0;
        state.progress.eta = parsed.eta;
      }
    };
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", onLine);
    proc.stderr.setEncoding("utf8");
    let stderrTail = "";
    proc.stderr.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2000);
      const err = stderrTail.match(/ERROR:\s*(.+?)(?:\r?\n|$)/);
      if (err) state.lastError = err[1]!.trim();
    });

    proc.once("error", (err: Error) => {
      // Only ENOENT (binary vanished between the candidates check and the
      // spawn) should ever land here after the candidate loop; the queue will
      // read it as a failure on its next poll.
      state.progress.status = "error";
      state.progress.error = err.message || "yt-dlp failed to start.";
    });

    proc.once("close", (code, signal) => {
      if (!this.procs.has(id)) return; // cancelled: the queue dropped it first
      if (signal) return; // we killed it (pause/remove): the queue already decided
      if (code === 0) {
        state.progress.status = "complete";
        state.progress.progress = 100;
        state.progress.speed = 0;
        state.progress.eta = undefined;
        if (state.progress.totalBytes) {
          state.progress.downloadedBytes = state.progress.totalBytes;
        }
        return;
      }
      state.progress.status = "error";
      state.progress.speed = 0;
      state.progress.eta = undefined;
      state.progress.error =
        state.lastError ?? `yt-dlp exited with code ${code ?? "unknown"}.`;
    });
  }

  /** Latest snapshot, or null when the id is unknown (never started / removed). */
  stats(id: string): YtDlpProgress | null {
    return this.procs.get(id)?.progress ?? null;
  }

  /** Kill the process and drop the handle. The queue paused this item; resume
   *  spawns it again and yt-dlp continues the partial .part file. */
  pause(id: string): void {
    const state = this.procs.get(id);
    if (!state) return;
    this.procs.delete(id); // delete first so the close handler stays silent
    state.proc.kill();
  }

  /** Kill and forget entirely (cancel / removal / completed cleanup). */
  remove(id: string): void {
    const state = this.procs.get(id);
    if (!state) return;
    this.procs.delete(id); // delete first so the close handler stays silent
    state.proc.kill();
  }

  destroy(): void {
    for (const id of [...this.procs.keys()]) this.remove(id);
  }
}
