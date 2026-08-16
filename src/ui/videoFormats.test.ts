import { describe, expect, it } from "vitest";
import { formatVideoOptions } from "./videoFormats";
import type { YtDlpInfoResult } from "../util/yt-dlp";

const infoWith = (heights: number[]): YtDlpInfoResult => ({
  ok: true,
  title: "Some Video",
  formats: heights.map((h) => ({ format_id: `f${h}`, ext: "mp4", height: h })),
});

const labels = (info: YtDlpInfoResult): string[] => formatVideoOptions(info).map((o) => o.label);

describe("formatVideoOptions", () => {
  it("returns nothing for a failed info fetch", () => {
    expect(formatVideoOptions({ ok: false, message: "boom" })).toEqual([]);
  });

  it("hides tiers above the video's best resolution", () => {
    // A 1080p video must not offer 4K — picking it used to fail with
    // "Requested format is not available".
    expect(labels(infoWith([360, 720, 1080]))).toEqual(["1080p", "720p", "360p", "mp3"]);
    expect(labels(infoWith([2160, 1080]))).toEqual(["4K", "1080p", "720p", "360p", "mp3"]);
    expect(labels(infoWith([480]))).toEqual(["360p", "mp3"]);
  });

  it("keeps every tier when the formats carry no height info", () => {
    expect(labels({ ok: true, title: "x", formats: [] })).toEqual([
      "4K",
      "1080p",
      "720p",
      "360p",
      "mp3",
    ]);
  });

  it("ends every video tier in a degradation chain so a missing format falls back", () => {
    for (const o of formatVideoOptions(infoWith([2160]))) {
      if (o.label === "mp3") continue;
      expect(o.value.endsWith("/bestvideo+bestaudio/best")).toBe(true);
    }
  });

  it("keeps mp3 as the final option", () => {
    const opts = formatVideoOptions(infoWith([720]));
    expect(opts.at(-1)).toMatchObject({ value: "audio_mp3", label: "mp3" });
  });
});
