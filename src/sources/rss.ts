import { fetchResilient, HttpError, USER_AGENT } from "../util/net";
import { toUnixSeconds } from "../util/format";
import type { SearchOptions, SourceId, TorrentResult } from "./types";

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

// Single-pass decode: every numeric entity (decimal and hex) plus the handful
// of named ones these feeds actually emit. One pass matters — sequential
// replaces would re-decode their own output (&amp;#38; must stay &#38;).
// Unknown or invalid entities pass through untouched; smart punctuation folds
// to its plain-ASCII look-alike so titles stay terminal-friendly.
export function unescapeEntities(s: string): string {
  return s
    .replace(/&#(x[0-9a-f]+|\d+);|&([a-z]+);/gi, (m, num: string, name: string) => {
      if (num) {
        const code = /^x/i.test(num) ? parseInt(num.slice(1), 16) : parseInt(num, 10);
        try {
          return String.fromCodePoint(code);
        } catch {
          return m; // out of range for a code point
        }
      }
      return NAMED_ENTITIES[name.toLowerCase()] ?? m;
    })
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, "-");
}

function parseRssItems(xml: string, source: SourceId): TorrentResult[] {
  const items = xml.split("<item>").slice(1);
  const out: TorrentResult[] = [];
  for (const item of items) {
    const magnetMatch = item.match(/href="(magnet:\?xt=urn:btih:[^"]+)"/i);
    if (!magnetMatch) continue;
    const magnet = unescapeEntities(magnetMatch[1]!);
    const infoHash = magnet.match(/urn:btih:([a-zA-Z0-9]+)/)?.[1]?.toLowerCase() ?? "";
    if (!infoHash) continue;

    const name = unescapeEntities(item.match(/<title>(.*?)<\/title>/)?.[1] ?? "Unknown Title");
    const added = toUnixSeconds(item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1]) ?? 0;

    out.push({ infoHash, name, sizeBytes: 0, seeders: 0, leechers: 0, source, magnet, added });
  }
  return out;
}

const WP_FEED_PAGE_SIZE = 10;
const FEED_DEPTH = 3;
const DEEP_PAGE_RETRIES = 2;

function feedUrl(base: string, query: string, page: number): string {
  const q = query.trim();
  const url = q
    ? `${base}/?s=${encodeURIComponent(q)}&feed=rss2`
    : `${base}/feed/`;
  if (page <= 1) return url;
  return `${url}${q ? "&" : "?"}paged=${page}`;
}

async function fetchFeedPage(
  url: string,
  source: SourceId,
  opts: SearchOptions,
  retries?: number,
): Promise<string> {
  const res = await fetchResilient(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: opts.signal,
    ...(retries !== undefined ? { retries } : {}),
  });
  if (!res.ok) throw new HttpError(res.status, `${source} feed returned ${res.status}`);
  return res.text();
}

export async function fetchWordpressRss(
  base: string,
  source: SourceId,
  query: string,
  opts: SearchOptions = {},
): Promise<TorrentResult[]> {
  const first = await fetchFeedPage(feedUrl(base, query, 1), source, opts);
  const results = parseRssItems(first, source);

  const rawCount = first.split("<item>").length - 1;
  if (rawCount < WP_FEED_PAGE_SIZE) return results;

  const deeper = await Promise.all(
    Array.from({ length: FEED_DEPTH - 1 }, (_, i) =>
      fetchFeedPage(feedUrl(base, query, i + 2), source, opts, DEEP_PAGE_RETRIES)
        .then((xml) => parseRssItems(xml, source))
        .catch(() => [] as TorrentResult[]),
    ),
  );

  const seen = new Set(results.map((r) => r.infoHash));
  for (const r of deeper.flat()) {
    if (seen.has(r.infoHash)) continue;
    seen.add(r.infoHash);
    results.push(r);
  }
  return results;
}
