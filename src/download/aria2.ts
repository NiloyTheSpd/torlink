// aria2 direct-URL downloads: binary resolution, JSON-RPC engine, and the URL
// heuristics that route a typed/pasted link to a direct download.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// --- binary resolution -------------------------------------------------------

// The install-time postinstall (scripts/ensure-aria2.cjs) drops the official
// Windows build here; other platforms resolve a system aria2c instead. The
// walk reaches the package root from the dev layout (src/download -> ../..)
// and from the tsup bundle (dist -> ..).
function packageRoot(): string {
  let dir =
    typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    if (existsSync(resolve(dir, "package.json"))) return dir;
    dir = resolve(dir, "..");
  }
  return dir;
}

const BUNDLED_ARIA2 = resolve(
  packageRoot(),
  "vendor",
  "aria2",
  process.platform === "win32" ? "aria2c.exe" : "aria2c",
);

export function aria2Binary(): string {
  return existsSync(BUNDLED_ARIA2) ? BUNDLED_ARIA2 : "aria2c";
}

// --- JSON-RPC transport ------------------------------------------------------

export class Aria2RpcError extends Error {
  code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.name = "Aria2RpcError";
    this.code = code;
  }
}

// Minimal JSON-RPC 2.0 client for aria2's HTTP endpoint. Every request carries
// the secret as params[0] ("token:<secret>"), matching aria2's RPC auth.
export class Aria2Rpc {
  private id = 0;
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
  ) {}

  async call<T>(method: string, ...params: unknown[]): Promise<T> {
    const body = {
      jsonrpc: "2.0",
      id: String(++this.id),
      method: `aria2.${method}`,
      params: [`token:${this.secret}`, ...params],
    };
    let res: Response;
    try {
      res = await fetch(this.baseUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      // fetch failed: connection refused / engine not running.
      const msg = e instanceof Error ? e.message : String(e);
      throw new Aria2RpcError(`aria2 unreachable: ${msg}`);
    }
    if (!res.ok) {
      throw new Aria2RpcError(`aria2 rpc HTTP ${res.status}`);
    }
    let parsed: { result?: T; error?: { code?: number; message?: string } };
    try {
      parsed = (await res.json()) as { result?: T; error?: { code?: number; message?: string } };
    } catch {
      throw new Aria2RpcError("aria2 rpc returned invalid json");
    }
    if (parsed.error) {
      throw new Aria2RpcError(parsed.error.message ?? "aria2 rpc error", parsed.error.code);
    }
    return parsed.result as T;
  }
}

// --- engine ------------------------------------------------------------------

export type Aria2DownloadStatus = "active" | "waiting" | "paused" | "error" | "complete" | "removed";

export interface Aria2Status {
  status: Aria2DownloadStatus;
  progress: number; // 0-100
  downloaded: number;
  total: number;
  speed: number; // bytes/sec
  connections: number;
  timeRemaining: number; // ms
  name?: string;
  errorMessage?: string;
}

export interface Aria2Process {
  pid?: number;
  kill(signal?: string | number): boolean;
  once(event: "error" | "exit", listener: (...args: unknown[]) => void): void;
}

export interface Aria2EngineOptions {
  // Override the aria2c path (tests); default: bundled -> system resolution.
  binary?: string;
  // Fixed RPC secret / port picker (tests); defaults are random.
  secret?: string;
  pickPort?: () => number;
  // Inject a ready-to-use RPC client: the engine then never spawns a process
  // (tests, or a future externally-hosted aria2). 
  rpc?: Aria2Rpc;
  spawnImpl?: (cmd: string, args: string[], opts: { windowsHide: boolean }) => Aria2Process;
}

const SPAWN_ATTEMPTS = 3;
const PING_RETRIES = 10;
const PING_INTERVAL_MS = 150;
const SHUTDOWN_GRACE_MS = 1500;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function randomPort(): number {
  return 30000 + Math.floor(Math.random() * 30000);
}

// RPC responses carry every numeric field as a string; normalize once here.
interface TellStatusResponse {
  status: Aria2DownloadStatus;
  totalLength?: string;
  completedLength?: string;
  downloadSpeed?: string;
  connections?: string;
  errorMessage?: string;
  files?: { path?: string }[];
}

function mapStatus(r: TellStatusResponse): Aria2Status {
  const total = Number(r.totalLength) || 0;
  const downloaded = Number(r.completedLength) || 0;
  const speed = Number(r.downloadSpeed) || 0;
  const connections = Number(r.connections) || 0;
  const progress = total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0;
  const timeRemaining = total > 0 && speed > 0 ? ((total - downloaded) / speed) * 1000 : 0;
  const path = r.files?.[0]?.path;
  const name = path ? path.split(/[\\/]/).filter(Boolean).pop() : undefined;
  return {
    status: r.status,
    progress,
    downloaded,
    total,
    speed,
    connections,
    timeRemaining,
    name,
    errorMessage: r.errorMessage || undefined,
  };
}

// Errors whose download-level outcome is already what the caller wanted.
function isHarmless(e: unknown, patterns: RegExp[]): boolean {
  return e instanceof Aria2RpcError && patterns.some((p) => p.test(e.message));
}

const NOT_FOUND = [/not found/i];
const ALREADY_PAUSED = [/already paused/i, /not found/i];
const ALREADY_ACTIVE = [/already active/i, /not found/i];

/**
 * Spawns a headless aria2c speaking JSON-RPC over localhost HTTP and exposes
 * the download operations the queue needs. Construction is inert: nothing is
 * spawned or contacted until the first operation, so a queue can hold an
 * engine even where aria2c is absent.
 */
export class Aria2Engine {
  private readonly external: boolean;
  private readonly binary: string;
  private readonly secret: string;
  private readonly pickPort: () => number;
  private readonly spawnImpl: (
    cmd: string,
    args: string[],
    opts: { windowsHide: boolean },
  ) => Aria2Process;
  private rpc: Aria2Rpc;
  private proc: Aria2Process | null = null;
  private started = false;
  private starting: Promise<void> | null = null;

  constructor(opts: Aria2EngineOptions = {}) {
    this.external = !!opts.rpc;
    this.binary = opts.binary ?? aria2Binary();
    this.secret = opts.secret ?? randomBytes(16).toString("hex");
    this.pickPort = opts.pickPort ?? randomPort;
    this.spawnImpl = opts.spawnImpl ?? ((cmd, args, spawnOpts) => spawn(cmd, args, spawnOpts));
    // Spawn mode creates the real client inside start(), against the chosen
    // port; this placeholder is only there so `rpc` is never undefined, and is
    // never contacted (start() replaces it before any call).
    this.rpc =
      opts.rpc ?? new Aria2Rpc("http://127.0.0.1:1/jsonrpc", this.secret);
  }

  private async ensureStarted(): Promise<void> {
    if (this.started) return;
    if (this.starting) return this.starting;
    this.starting = this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  /** Bring the engine up (spawn + readiness ping, or verify an injected rpc).
   *  Idempotent; the per-operation methods auto-start on first use. */
  async start(): Promise<void> {
    if (this.external) {
      // An injected client: verify reachability, then trust it.
      await this.rpc.call("getVersion");
      this.started = true;
      return;
    }
    let lastError: unknown = null;
    for (let attempt = 0; attempt < SPAWN_ATTEMPTS; attempt++) {
      const port = this.pickPort();
      this.rpc = new Aria2Rpc(`http://127.0.0.1:${port}/jsonrpc`, this.secret);
      const proc = this.spawnImpl(this.binary, this.spawnArgs(port), {
        windowsHide: true,
      });
      this.proc = proc;
      proc.once("exit", () => {
        if (this.proc === proc) {
          this.proc = null;
          this.started = false;
        }
      });
      const outcome = await Promise.race([
        this.pingUntilReady().then((ok) => (ok ? ("ready" as const) : ("unreachable" as const))),
        this.spawnError(proc),
      ]);
      if (outcome === "ready") {
        this.started = true;
        return;
      }
      if (outcome === "enoent") {
        this.proc = null;
        throw new Aria2RpcError(
          "aria2c was not found. Install aria2 (https://aria2.github.io) or run the torlnk installer.",
        );
      }
      // Port conflict / slow start / transient spawn failure: tear down and
      // retry with a fresh port.
      lastError =
        outcome === "unreachable" ? new Aria2RpcError("aria2 rpc never became ready") : outcome;
      proc.kill();
      this.proc = null;
    }
    throw lastError instanceof Error ? lastError : new Aria2RpcError("could not start aria2");
  }

  private spawnArgs(port: number): string[] {
    return [
      "--enable-rpc=true",
      `--rpc-listen-port=${port}`,
      `--rpc-secret=${this.secret}`,
      "--rpc-listen-all=false",
      "--max-concurrent-downloads=64",
      "--file-allocation=none",
      "--console-log-level=error",
    ];
  }

  private async pingUntilReady(): Promise<boolean> {
    for (let i = 0; i < PING_RETRIES; i++) {
      try {
        await this.rpc.call("getVersion");
        return true;
      } catch {
        await sleep(PING_INTERVAL_MS);
      }
    }
    return false;
  }

  // Resolves when the spawned binary fails to launch at all.
  private spawnError(proc: Aria2Process): Promise<Error | "enoent" | null> {
    return new Promise((resolve) => {
      proc.once("error", (e) => {
        const err = e instanceof Error ? e : new Error(String(e));
        if ((err as NodeJS.ErrnoException).code === "ENOENT") resolve("enoent");
        else resolve(err);
      });
    });
  }

  async add(url: string, dir: string): Promise<string> {
    await this.ensureStarted();
    const opts: Record<string, string> = {
      dir,
      split: "16",
      "max-connection-per-server": "16",
      "min-split-size": "1M",
    };
    const out = downloadNameFromUrl(url);
    if (out) opts.out = out;
    const result = await this.rpc.call<{ gid: string }>("addUri", [url], opts);
    return result.gid;
  }

  async stats(gid: string): Promise<Aria2Status | null> {
    try {
      await this.ensureStarted();
      const r = await this.rpc.call<TellStatusResponse>("tellStatus", gid, [
        "status",
        "totalLength",
        "completedLength",
        "downloadSpeed",
        "connections",
        "errorMessage",
        "files",
      ]);
      return mapStatus(r);
    } catch (e) {
      // Unknown gid, dead engine, anything: no stats today.
      if (isHarmless(e, NOT_FOUND) || e instanceof Aria2RpcError) return null;
      throw e;
    }
  }

  async pause(gid: string): Promise<void> {
    await this.ensureStarted();
    try {
      await this.rpc.call("pause", gid);
    } catch (e) {
      if (!isHarmless(e, ALREADY_PAUSED)) throw e;
    }
  }

  async unpause(gid: string): Promise<void> {
    await this.ensureStarted();
    try {
      await this.rpc.call("unpause", gid);
    } catch (e) {
      if (!isHarmless(e, ALREADY_ACTIVE)) throw e;
    }
  }

  async remove(gid: string): Promise<void> {
    await this.ensureStarted();
    try {
      await this.rpc.call("remove", gid);
    } catch (e) {
      if (!isHarmless(e, NOT_FOUND)) throw e;
    }
    try {
      await this.rpc.call("removeDownloadResult", gid);
    } catch {
      // result record already gone — fine
    }
  }

  async destroy(): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    this.started = false;
    if (this.external || !proc) return;
    try {
      await Promise.race([
        this.rpc.call("shutdown").catch(() => null),
        sleep(SHUTDOWN_GRACE_MS).then(() => null),
      ]);
    } finally {
      proc.kill();
    }
  }
}

// Direct-download extensions (pathname, case-insensitive). Anything else is
// presumed to be a page the user wants yt-dlp to extract from, so video sites
// never accidentally fall into aria2.
const DIRECT_EXT =
  /\.(?:zip|rar|7z|tar|gz|bz2|xz|zst|iso|img|exe|msi|apk|deb|rpm|dmg|pkg|mp4|mkv|avi|mov|webm|flac|mp3|wav|ogg|oga|opus|pdf|epub|djvu|mobi|azw3|torrent|bin|nupkg|whl|jar|ttf|otf|woff2?|docx?|xlsx?|pptx?)$/i;

export function looksLikeDirectDownload(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return DIRECT_EXT.test(u.pathname);
}

// The last non-empty path segment, percent-decoded, when it has a file
// extension (a name worth pinning via `out`). Null for extension-less paths:
// there the server's Content-Disposition should decide the filename (think
// /download?id=3 → report.pdf), and pinning a verb like "download" would
// clobber it.
export function downloadNameFromUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const pathname = u.pathname;
  if (pathname.endsWith("/")) return null; // trailing slash: a directory, not a file
  const segment = pathname.split("/").filter(Boolean).pop();
  if (!segment || !DIRECT_EXT.test(segment)) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment; // malformed percent-encoding: keep the raw segment
  }
}
