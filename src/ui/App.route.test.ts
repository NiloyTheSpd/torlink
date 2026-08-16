import { describe, expect, it } from "vitest";
import { routeUrlInput } from "./App";

describe("routeUrlInput", () => {
  it("routes a direct-file URL to aria2", () => {
    expect(routeUrlInput("https://example.com/payload-5mb.bin")).toEqual({
      kind: "direct",
      url: "https://example.com/payload-5mb.bin",
    });
  });

  it("routes a stream URL to yt-dlp", () => {
    expect(routeUrlInput("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toEqual({
      kind: "video",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
  });

  it("forces direct with the dl prefix even for page-like URLs", () => {
    expect(routeUrlInput("dl https://example.com/watch?id=3")).toEqual({
      kind: "direct",
      url: "https://example.com/watch?id=3",
    });
  });

  it("extracts a URL embedded in surrounding text", () => {
    expect(routeUrlInput("grab https://example.com/file.zip please")).toEqual({
      kind: "direct",
      url: "https://example.com/file.zip",
    });
  });

  it("returns null when no URL is present", () => {
    expect(routeUrlInput("some movie")).toBeNull();
    expect(routeUrlInput("")).toBeNull();
  });
});
