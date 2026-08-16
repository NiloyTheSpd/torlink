import type { YtDlpInfoResult } from "../util/yt-dlp";

export interface VideoQualityOption {
  value: string;
  label: string;
  detail?: string;
}

// Each tier ends in a full degradation chain (…/bestvideo+bestaudio/best):
// picking a tier the video doesn't actually have must fall back to the best
// available format instead of dying with yt-dlp's "Requested format is not
// available" — which is exactly what a 4K pick on a 1080p-only video did
// before the tail existed.
const FALLBACK = "/bestvideo+bestaudio/best";

const TIERS: { label: string; detail: string; min: number; expr: string }[] = [
  {
    label: "4K",
    detail: "2160p and above",
    min: 2160,
    expr: "bestvideo[height>=2160]+bestaudio/best[height>=2160]",
  },
  {
    label: "1080p",
    detail: "1080p to 2160p",
    min: 1080,
    expr: "bestvideo[height>=1080][height<2160]+bestaudio/best[height>=1080][height<2160]",
  },
  {
    label: "720p",
    detail: "720p to 1080p",
    min: 720,
    expr: "bestvideo[height>=720][height<1080]+bestaudio/best[height>=720][height<1080]",
  },
  {
    label: "360p",
    detail: "360p to 720p",
    min: 360,
    expr: "bestvideo[height>=360][height<720]+bestaudio/best[height>=360][height<720]",
  },
];

/** The quality menu for the format prompt, built from what the video has. */
export function formatVideoOptions(info: YtDlpInfoResult): VideoQualityOption[] {
  if (!info.ok) return [];
  const heights = info.formats.map((f) => f.height ?? 0).filter((h) => h > 0);
  const maxHeight = heights.length ? Math.max(...heights) : 0;
  const options = TIERS.filter(
    // Hide tiers above the best stream the video actually offers (no 4K row
    // for a 1080p upload). With no height info at all, keep every tier: the
    // fallback chain covers whatever yt-dlp finds at download time.
    (t) => maxHeight === 0 || maxHeight >= t.min,
  ).map((t) => ({ value: `${t.expr}${FALLBACK}`, label: t.label, detail: t.detail }));
  options.push({
    value: "audio_mp3",
    label: "mp3",
    detail: "Download the best audio and convert to mp3",
  });
  return options;
}
