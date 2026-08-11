// aria2 direct-URL downloads: binary resolution, JSON-RPC engine, and the URL
// heuristics that route a typed/pasted link to a direct download.

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
