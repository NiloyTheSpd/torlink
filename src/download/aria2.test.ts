import { createServer, type Server } from "node:http";
import { describe, it, expect } from "vitest";
import { Aria2Rpc, Aria2RpcError, downloadNameFromUrl, looksLikeDirectDownload } from "./aria2";

// A minimal stand-in for aria2c's JSON-RPC endpoint: captures the request body
// and answers with whatever the test wants.
function fakeAria2Server(
  handler: (body: { method?: string; params?: unknown[] }) => { status?: number; body?: unknown },
): Promise<{ server: Server; port: number; requests: { method?: string; params?: unknown[] }[] }> {
  const requests: { method?: string; params?: unknown[] }[] = [];
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        let parsed: { method?: string; params?: unknown[] } = {};
        try {
          parsed = JSON.parse(raw) as { method?: string; params?: unknown[] };
        } catch {}
        requests.push(parsed);
        const { status = 200, body = { jsonrpc: "2.0", id: parsed.id ?? "0", result: null } } =
          handler(parsed);
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("no port"));
        return;
      }
      resolve({ server, port: addr.port, requests });
    });
  });
}

describe("Aria2Rpc", () => {
  it("posts jsonrpc with the token first and returns the result", async () => {
    const fake = await fakeAria2Server(() => ({
      body: { jsonrpc: "2.0", id: "1", result: { gid: "g1" } },
    }));
    try {
      const rpc = new Aria2Rpc(`http://127.0.0.1:${fake.port}/jsonrpc`, "s3cret");
      const out = await rpc.call("addUri", ["https://x/file.zip"], { dir: "/tmp" });
      expect(out).toEqual({ gid: "g1" });
      expect(fake.requests[0].method).toBe("aria2.addUri");
      const params = fake.requests[0].params;
      expect(params?.[0]).toBe("token:s3cret");
      expect(params?.[1]).toEqual(["https://x/file.zip"]);
    } finally {
      fake.server.close();
    }
  });

  it("throws Aria2RpcError with code and message on an rpc error result", async () => {
    const fake = await fakeAria2Server(() => ({
      body: { jsonrpc: "2.0", id: "1", error: { code: 4, message: "Already paused" } },
    }));
    try {
      const rpc = new Aria2Rpc(`http://127.0.0.1:${fake.port}/jsonrpc`, "s3cret");
      await expect(rpc.call("pause", "g1")).rejects.toMatchObject({
        name: "Aria2RpcError",
        code: 4,
        message: "Already paused",
      });
    } finally {
      fake.server.close();
    }
  });

  it("throws on a non-200 http response", async () => {
    const fake = await fakeAria2Server(() => ({ status: 500, body: { error: "boom" } }));
    try {
      const rpc = new Aria2Rpc(`http://127.0.0.1:${fake.port}/jsonrpc`, "s3cret");
      await expect(rpc.call("getVersion")).rejects.toThrow(/HTTP 500/);
    } finally {
      fake.server.close();
    }
  });

  it("propagates connection failures when the engine is unreachable", async () => {
    // Grab a port by listening, then close: nothing listens there anymore.
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const addr = probe.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    const port = addr.port;
    await new Promise<void>((r) => probe.close(() => r()));

    const rpc = new Aria2Rpc(`http://127.0.0.1:${port}/jsonrpc`, "s3cret");
    await expect(rpc.call("getVersion")).rejects.toThrow();
  });
});

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
