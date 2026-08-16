import type { SearchOptions, Source, TorrentResult } from "./types";

const TTL_MS = 5 * 60 * 1000;

interface Entry {
  at: number;
  results: TorrentResult[];
}

const cache = new Map<string, Entry>();

// The sources' search endpoints are case-insensitive, so the key folds case:
// "Foo" and "foo" share one cached search instead of re-hitting the network.
function key(sourceId: string, query: string): string {
  return `${sourceId}::${query.trim().toLowerCase()}`;
}

export async function cachedSearch(
  source: Source,
  query: string,
  opts: SearchOptions = {},
): Promise<TorrentResult[]> {
  const k = key(source.id, query);
  const hit = cache.get(k);
  if (hit) {
    if (Date.now() - hit.at < TTL_MS) return hit.results;
    cache.delete(k); // stale: drop now so the map never grows unbounded
  }

  const results = await source.search(query, opts);
  cache.set(k, { at: Date.now(), results });
  return results;
}
