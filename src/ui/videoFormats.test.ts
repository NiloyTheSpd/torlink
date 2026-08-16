import { describe, expect, it } from "vitest";
import { formatVideoOptions } from "./videoFormats";
import type { YtDlpFormat, YtDlpInfoResult } from "../util/yt-dlp";

const fmt = (over: Partial<YtDlpFormat>): YtDlpFormat => ({
  format_id: over.format_id ?? "f0",
  ext: "mp4",
  vcodec: "avc1",
  acodec: "mp4a",
  ...over,
});

const infoWith = (formats: YtDlpFormat[]): YtDlpInfoResult => ({
  ok: true,
  title: "Some Video",
  formats,
});

describe("formatVideoOptions", () => {
  it("returns nothing for a failed info fetch", () => {
    expect(formatVideoOptions({ ok: false, message: "boom" })).toEqual([]);
  });

  it("offers exactly the resolutions the video reports, best first", () => {
    const opts = formatVideoOptions(
      infoWith([
        fmt({ format_id: "v1080", height: 1080, vcodec: "vp9", acodec: "none", tbr: 4000 }),
        fmt({ format_id: "v360", height: 360, vcodec: "vp9", acodec: "none", tbr: 600 }),
        fmt({ format_id: "v720", height: 720, vcodec: "vp9", acodec: "none", tbr: 2000 }),
        fmt({ format_id: "a0", acodec: "mp4a", vcodec: "none", abr: 128 }),
      ]),
    );
    expect(opts.map((o) => o.label)).toEqual(["1080p", "720p", "360p", "mp3"]);
  });

  it("never offers a resolution the video does not have", () => {
    const opts = formatVideoOptions(
      infoWith([fmt({ format_id: "v720", height: 720, acodec: "none", tbr: 2000 })]),
    );
    expect(opts.map((o) => o.label)).toEqual(["720p", "mp3"]);
  });

  it("caps each expression at the chosen height with a degradation chain", () => {
    const opts = formatVideoOptions(
      infoWith([
        fmt({ format_id: "v1080", height: 1080, acodec: "none" }),
        fmt({ format_id: "v480", height: 480, acodec: "none" }),
      ]),
    );
    expect(opts[0]!.value).toBe(
      "bestvideo[height<=1080]+bestaudio/best[height<=1080]/bestvideo+bestaudio/best",
    );
    expect(opts[1]!.value).toBe(
      "bestvideo[height<=480]+bestaudio/best[height<=480]/bestvideo+bestaudio/best",
    );
  });

  it("describes the stream that will actually be picked: fps and merged size", () => {
    const opts = formatVideoOptions(
      infoWith([
        fmt({
          format_id: "v1080",
          height: 1080,
          ext: "webm",
          fps: 60,
          acodec: "none",
          tbr: 4000,
          filesize: 100 * 1024 ** 2,
        }),
        fmt({ format_id: "a0", acodec: "mp4a", vcodec: "none", abr: 128, filesize: 3 * 1024 ** 2 }),
      ]),
    );
    expect(opts[0]!.detail).toBe("webm · 60fps · ~103.00 MB");
  });

  it("ignores audio-only formats even when they carry odd height metadata", () => {
    const opts = formatVideoOptions(
      infoWith([
        fmt({ format_id: "v720", height: 720, acodec: "none" }),
        fmt({ format_id: "a1", height: 220, acodec: "mp4a", vcodec: "none" }),
        fmt({ format_id: "sb", height: 48, vcodec: "none", acodec: "none" }), // storyboard
      ]),
    );
    expect(opts.map((o) => o.label)).toEqual(["720p", "mp3"]);
  });

  it("falls back to a single guarded 'best' option when no heights are known", () => {
    // Playlists and some protected streams report no usable formats.
    expect(formatVideoOptions(infoWith([])).map((o) => o.label)).toEqual(["best", "mp3"]);
    expect(formatVideoOptions(infoWith([]))[0]!.value).toBe("bestvideo+bestaudio/best");
  });

  it("keeps mp3 (the audio mode) as the final option", () => {
    const opts = formatVideoOptions(infoWith([fmt({ format_id: "v360", height: 360, acodec: "none" })]));
    expect(opts.at(-1)).toMatchObject({ value: "audio_mp3", label: "mp3" });
  });
});
