// aria2 direct-URL downloads: binary resolution, JSON-RPC engine, and the URL
// heuristics that route a typed/pasted link to a direct download.

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
