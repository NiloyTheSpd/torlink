import { describe, it, expect } from "vitest";
import { downloadNameFromUrl, looksLikeDirectDownload } from "./aria2";

describe("looksLikeDirectDownload", () => {
  it("accepts common direct-download extensions", () => {
    for (const url of [
      "https://example.com/file.zip",
      "https://example.com/dist/ubuntu-24.04.iso",
      "https://example.com/files/setup.exe?token=abc123",
      "https://example.com/album/song.mp3",
      "https://example.com/books/manual.pdf",
      "https://example.com/video/movie.mkv",
      "https://example.com/archives/backup.tar.gz",
      "https://example.com/app/app.apk",
      "https://example.com/game/update.7z",
    ]) {
      expect(looksLikeDirectDownload(url), url).toBe(true);
    }
  });

  it("rejects URLs without a direct-file extension (video pages, endpoints)", () => {
    for (const url of [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://example.com/video?id=5",
      "https://example.com/download",
      "https://example.com/",
      "https://example.com/files/",
      "https://example.com",
      "https://example.com/search?q=file.zip+download", // extension in query, not path
    ]) {
      expect(looksLikeDirectDownload(url), url).toBe(false);
    }
  });

  it("matches extensions case-insensitively", () => {
    expect(looksLikeDirectDownload("https://example.com/archive.ZIP")).toBe(true);
    expect(looksLikeDirectDownload("https://example.com/clip.MP4")).toBe(true);
  });

  it("accepts ftp links too", () => {
    expect(looksLikeDirectDownload("ftp://mirror.example.com/pub/file.iso")).toBe(true);
    expect(looksLikeDirectDownload("ftp://mirror.example.com/pub/README")).toBe(false);
  });
});

describe("downloadNameFromUrl", () => {
  it("returns the decoded basename for file-like paths", () => {
    expect(downloadNameFromUrl("https://example.com/dir/my%20file.zip")).toBe(
      "my file.zip",
    );
    expect(downloadNameFromUrl("https://example.com/file.iso")).toBe("file.iso");
  });

  it("returns null when the URL has no file-like name (server decides via Content-Disposition)", () => {
    for (const url of [
      "https://example.com",
      "https://example.com/",
      "https://example.com/path/",
      "https://example.com/download?id=3",
      "https://example.com/file",
      "https://example.com/releases/latest",
    ]) {
      expect(downloadNameFromUrl(url), url).toBeNull();
    }
  });

  it("falls back to the raw segment when decoding fails", () => {
    expect(downloadNameFromUrl("https://example.com/%E0%A4%A.zip")).toBe(
      "%E0%A4%A.zip",
    );
  });
});
