import { formatBytes } from "../util/format";
import type { YtDlpFormat, YtDlpInfoResult } from "../util/yt-dlp";

export interface VideoQualityOption {
  value: string;
  label: string;
  detail?: string;
}

// Every video option ends in a full degradation chain so a stream that
// vanished between the info fetch and the download falls back to the best
// available format instead of failing with "Requested format is not
// available".
const FALLBACK = "/bestvideo+bestaudio/best";

const isVideoFormat = (f: YtDlpFormat): boolean =>
  !!f.vcodec && f.vcodec !== "none" && (f.height ?? 0) > 0;

const isAudioFormat = (f: YtDlpFormat): boolean => !!f.acodec && f.acodec !== "none";

const bitrate = (f: YtDlpFormat): number => f.tbr ?? f.abr ?? 0;

const sizeOf = (f?: YtDlpFormat): number => (f ? f.filesize ?? f.filesize_approx ?? 0 : 0);

/** The quality menu for the format prompt: one row per resolution the video
 *  actually offers (best first), then the audio (mp3) mode. Built from the
 *  real yt-dlp format list — nothing is offered that isn't there. */
export function formatVideoOptions(info: YtDlpInfoResult): VideoQualityOption[] {
  if (!info.ok) return [];

  const videoFormats = info.formats.filter(isVideoFormat);
  const bestAudio = info.formats.filter(isAudioFormat).sort((a, b) => bitrate(b) - bitrate(a))[0];

  const heights = [...new Set(videoFormats.map((f) => f.height!))].sort((a, b) => b - a);
  const options: VideoQualityOption[] = heights.map((h) => {
    // The streams at this height, best bitrate first: the first is the one
    // the download will actually take, so its fps/size drive the detail row.
    const atHeight = videoFormats
      .filter((f) => f.height === h)
      .sort((a, b) => bitrate(b) - bitrate(a));
    const best = atHeight[0]!;
    const fps = Math.round(best.fps ?? 0);
    // A merged download is video + best audio, so estimate both halves.
    const bytes = sizeOf(best) + sizeOf(bestAudio);
    const detail = [
      best.ext,
      fps > 0 ? `${fps}fps` : "",
      bytes > 0 ? `~${formatBytes(bytes)}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    return {
      value: `bestvideo[height<=${h}]+bestaudio/best[height<=${h}]${FALLBACK}`,
      label: `${h}p`,
      detail,
    };
  });

  if (options.length === 0) {
    // No usable height info (playlists, some protected streams): offer a
    // single guarded best option rather than an empty menu.
    options.push({
      value: `bestvideo+bestaudio/best`,
      label: "best",
      detail: "best available quality",
    });
  }

  options.push({
    value: "audio_mp3",
    label: "mp3",
    detail: "Download the best audio and convert to mp3",
  });
  return options;
}
