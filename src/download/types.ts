import type { SourceId } from "../sources/types";

// "queued" = waiting for a free download slot (see TORLINK_MAX_DOWNLOADS). Unlike
// "paused" (an explicit user action) a queued item is started automatically as
// soon as a slot frees.
export type DownloadStatus = "downloading" | "queued" | "paused" | "completed" | "failed";

export type SeedStatus = "seeding" | "paused" | "missing";

export interface SeedItem {
  id: string;
  name: string;
  source?: SourceId;
  magnet: string;
  dir: string;
  sizeBytes: number;
  status: SeedStatus;
  uploadSpeed: number;
  uploaded: number;
  peers: number;
}

export interface QueueItem {
  id: string;
  name: string;
  source?: SourceId;
  magnet: string;
  // A direct http(s)/ftp URL (aria2 download). Present exactly when this item
  // is a direct download; torrent items leave it unset and keep magnet set.
  url?: string;
  // A yt-dlp video/audio download (single video or playlist). Present exactly
  // when this item is a media download; magnet stays empty. Kept separate
  // from `url` so queue routing never confuses the two engines.
  video?: VideoDownloadSpec;
  dir: string;
  status: DownloadStatus;
  progress: number;
  totalBytes: number;
  downloadedBytes: number;
  speed: number;
  peers: number;
  eta?: number;
  files?: number;
  error?: string;
  addedAt: number;
}

// Everything needed to (re)start a yt-dlp download: the page URL plus the
// chosen quality. yt-dlp resumes .part files on restart via --continue.
export interface VideoDownloadSpec {
  url: string;
  formatId?: string;
  audioMp3?: boolean;
  isPlaylist?: boolean;
}
