import { describe, expect, it, vi, afterEach } from "vitest";
import { cachedSearch } from "./cache";
import type { Source, TorrentResult } from "./types";

const result = (hash: string): TorrentResult => ({
  infoHash: hash,
  name: `item ${hash}`,
  sizeBytes: 1,
  seeders: 0,
  leechers: 0,
  source: "nyaa",
  magnet: `magnet:?xt=urn:btih:${hash}`,
});

// The cache is module-level, so every test uses its own source id to get its
// own key space.
const source = (id: string, impl: (query: string) => Promise<TorrentResult[]>): Source =>
  ({
    id,
    label: "Test",
    groups: [],
    homepage: "https://x.test",
    reportsHealth: true,
    search: vi.fn(impl),
  }) as unknown as Source;

describe("cachedSearch", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("serves a fresh hit without re-hitting the source", async () => {
    vi.useFakeTimers({ now: Date.now() });
    const search = vi.fn(async () => [result("a".repeat(40))]);
    const src = source("fresh", search);

    const first = await cachedSearch(src, "ubuntu");
    const second = await cachedSearch(src, "ubuntu");

    expect(second).toEqual(first);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("re-requests and refreshes after the TTL expires", async () => {
    vi.useFakeTimers({ now: Date.now() });
    const search = vi.fn(async (q: string) => [result(q.padEnd(40, "0"))]);
    const src = source("ttl", search);

    await cachedSearch(src, "ubuntu");
    vi.advanceTimersByTime(5 * 60 * 1000 + 1); // past the 5-minute TTL
    await cachedSearch(src, "ubuntu");

    expect(search).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failed search", async () => {
    const search = vi.fn(async () => {
      throw new Error("source down");
    });
    const src = source("nofail", search);

    await expect(cachedSearch(src, "ubuntu")).rejects.toThrow("source down");
    // No entry was stored under the key, so the retry hits the source again.
    await expect(cachedSearch(src, "ubuntu")).rejects.toThrow("source down");
    expect(search).toHaveBeenCalledTimes(2);
  });

  it("shares one entry across case variants and surrounding space", async () => {
    vi.useFakeTimers({ now: Date.now() });
    const search = vi.fn(async () => [result("b".repeat(40))]);
    const src = source("casefold", search);

    await cachedSearch(src, "Ubuntu");
    await cachedSearch(src, "  ubuntu ");
    await cachedSearch(src, "UBUNTU");

    expect(search).toHaveBeenCalledTimes(1);
  });

  it("keeps entries per source", async () => {
    vi.useFakeTimers({ now: Date.now() });
    const searchA = vi.fn(async () => [result("c".repeat(40))]);
    const searchB = vi.fn(async () => [result("d".repeat(40))]);

    await cachedSearch(source("src-a", searchA), "ubuntu");
    await cachedSearch(source("src-b", searchB), "ubuntu");

    expect(searchA).toHaveBeenCalledTimes(1);
    expect(searchB).toHaveBeenCalledTimes(1);
  });
});
