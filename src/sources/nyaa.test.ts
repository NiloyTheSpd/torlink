import { describe, expect, it } from "vitest";
import { mapNyaaXml } from "./nyaa";

const HASH_A = "0123456789abcdef0123456789abcdef01234567";
const HASH_B = "89abcdef0123456789abcdef0123456789abcdef";

const item = (body: string): string => `<item>${body}</item>`;

const rss = (...items: string[]): string =>
  `<rss><channel><title>Nyaa</title>${items.join("")}</channel></rss>`;

describe("mapNyaaXml", () => {
  it("maps a well-formed item with sizes, swarm counts, and pubDate", () => {
    const xml = rss(
      item(
        `<title>Some Release &amp; Batch</title>` +
          `<nyaa:infoHash>${HASH_A}</nyaa:infoHash>` +
          `<nyaa:size>1.4 GiB</nyaa:size>` +
          `<nyaa:seeders>42</nyaa:seeders>` +
          `<nyaa:leechers>7</nyaa:leechers>` +
          `<pubDate>Tue, 30 Jun 2026 00:00:00 +0000</pubDate>`,
      ),
    );

    const results = mapNyaaXml(xml);
    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.infoHash).toBe(HASH_A);
    expect(r.name).toBe("Some Release & Batch");
    expect(r.sizeBytes).toBe(Math.round(1.4 * 1024 ** 3));
    expect(r.seeders).toBe(42);
    expect(r.leechers).toBe(7);
    expect(r.added).toBe(Math.floor(Date.parse("Tue, 30 Jun 2026 00:00:00 +0000") / 1000));
    expect(r.magnet).toContain(`urn:btih:${HASH_A}`);
  });

  it("reads titles inside CDATA and skips pre-split junk", () => {
    const xml = rss(
      item(
        `<title><![CDATA[Show ~ Episode 12 [1080p]]]></title>` +
          `<nyaa:infoHash>${HASH_B}</nyaa:infoHash>` +
          `<nyaa:seeders>1</nyaa:seeders><nyaa:leechers>0</nyaa:leechers>`,
      ),
    );
    const results = mapNyaaXml(xml);
    expect(results[0]!.name).toBe("Show ~ Episode 12 [1080p]");
  });

  it("drops rows without an info hash or a title", () => {
    const xml = rss(
      item(`<title>hashless</title><nyaa:seeders>5</nyaa:seeders>`),
      item(`<nyaa:infoHash>${HASH_A}</nyaa:infoHash><nyaa:seeders>5</nyaa:seeders>`),
      item(`<title>titled</title><nyaa:infoHash>${HASH_A}</nyaa:infoHash>`),
    );
    expect(mapNyaaXml(xml)).toHaveLength(1);
  });

  it("falls back to zero for missing or garbage swarm counts", () => {
    const xml = rss(
      item(`<title>a</title><nyaa:infoHash>${HASH_A}</nyaa:infoHash>`),
      item(`<title>b</title><nyaa:infoHash>${HASH_B}</nyaa:infoHash><nyaa:seeders>n/a</nyaa:seeders>`),
    );
    const results = mapNyaaXml(xml);
    expect(results[0]!.seeders).toBe(0);
    expect(results[0]!.leechers).toBe(0);
    expect(results[1]!.seeders).toBe(0);
  });

  it("never produces a NaN added for a missing or malformed pubDate", () => {
    const xml = rss(
      item(`<title>a</title><nyaa:infoHash>${HASH_A}</nyaa:infoHash>`),
      item(
        `<title>b</title><nyaa:infoHash>${HASH_B}</nyaa:infoHash>` +
          `<pubDate>Tue, 99 Foo 2026 99:99:99 +0000</pubDate>`,
      ),
    );
    const results = mapNyaaXml(xml);
    expect(results[0]!.added).toBeUndefined();
    expect(results[1]!.added).toBeUndefined();
    // NaN would poison every sort comparator downstream.
    for (const r of results) expect(Number.isNaN(r.added!)).not.toBe(true);
  });
});
