// Best-effort delete of a torrent's on-disk data: only the torrent's own entry
// directly under its download dir (a file, or the folder named after it). Never
// walks outside that dir, never throws. Returns the deleted path, or null when
// nothing was deleted — an unusable name, or the rm itself failed (typically a
// file still held open by a player or antivirus on Windows). Callers must not
// report the data as gone on a null return. Shared by the seed reaper
// (auto-purge after the seed timer) and the headless control API (manual delete).

import { rm } from "node:fs/promises";
import path from "node:path";

export async function deleteSeedData(dir: string, name: string): Promise<string | null> {
  const base = path.basename(name.trim());
  if (!base || base === "." || base === "..") return null;
  const target = path.join(dir, base);
  try {
    await rm(target, { recursive: true, force: true });
  } catch {
    return null;
  }
  return target;
}
