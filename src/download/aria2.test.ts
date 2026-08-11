import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import { describe, it, expect, vi } from "vitest";
import {
  Aria2Engine,
  Aria2Process,
  Aria2Rpc,
  Aria2RpcError,
  downloadNameFromUrl,
  looksLikeDirectDownload,
} from "./aria2";

// A minimal stand-in for aria2c's JSON-RPC endpoint: captures the request body
// and answers with whatever the test wants.
function fakeAria2Server(
  handler: (body: { id?: string; method?: string; params?: unknown[] }) => {
    status?: number;
    body?: unknown;
  },
): Promise<{ server: Server; port: number; requests: { id?: string; method?: string; params?: unknown[] }[] }> {
  const requests: { id?: string; method?: string; params?: unknown[] }[] = [];
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        let parsed: { id?: string; method?: string; params?: unknown[] } = {};
        try {
          parsed = JSON.parse(raw) as { id?: string; method?: string; params?: unknown[] };
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
      expect(fake.requests[0]!.method).toBe("aria2.addUri");
      const params = fake.requests[0]!.params;
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

// A fake spawned process: records kill(), and lets the test emit lifecycle
// events (error/exit) the engine listens for.
function fakeProc(): Aria2Process & { kill: ReturnType<typeof vi.fn> } {
  const proc = new EventEmitter() as unknown as Aria2Process & {
    kill: ReturnType<typeof vi.fn>;
  };
  proc.kill = vi.fn(() => true);
  proc.pid = 4242;
  return proc;
}

describe("Aria2Engine with an injected rpc (no spawn)", () => {
  it("add() resolves the gid and pins dir/split options plus a derived out name", async () => {
    const fake = await fakeAria2Server(() => ({
      body: { jsonrpc: "2.0", id: "1", result: { gid: "g1" } },
    }));
    try {
      const engine = new Aria2Engine({
        rpc: new Aria2Rpc(`http://127.0.0.1:${fake.port}/jsonrpc`, "s3cret"),
      });
      await engine.start();
      const gid = await engine.add("https://x.example/file.zip", "/tmp/dl");
      expect(gid).toBe("g1");
      const call = fake.requests[1]!;
      expect(call.method).toBe("aria2.addUri");
      expect(call.params?.[1]).toEqual(["https://x.example/file.zip"]);
      expect(call.params?.[2]).toEqual({
        dir: "/tmp/dl",
        split: "16",
        "max-connection-per-server": "16",
        "min-split-size": "1M",
        out: "file.zip",
      });
    } finally {
      fake.server.close();
    }
  });

  it("stats() maps string lengths to numbers and derives the name from the file path", async () => {
    const fake = await fakeAria2Server(() => ({
      body: {
        jsonrpc: "2.0",
        id: "1",
        result: {
          gid: "g1",
          status: "active",
          totalLength: "1000",
          completedLength: "250",
          downloadSpeed: "100",
          connections: "8",
          files: [{ path: "/dl/my file.bin", length: "1000", completedLength: "250" }],
        },
      },
    }));
    try {
      const engine = new Aria2Engine({
        rpc: new Aria2Rpc(`http://127.0.0.1:${fake.port}/jsonrpc`, "s3cret"),
      });
      await engine.start();
      const s = await engine.stats("g1");
      expect(s).toMatchObject({
        status: "active",
        progress: 25,
        downloaded: 250,
        total: 1000,
        speed: 100,
        connections: 8,
        name: "my file.bin",
      });
      // (1000 - 250) bytes at 100 B/s → 7.5 s
      expect(s?.timeRemaining).toBe(7500);
    } finally {
      fake.server.close();
    }
  });

  it("stats() returns null for an unknown gid", async () => {
    const fake = await fakeAria2Server(({ method }) => ({
      body:
        method === "aria2.tellStatus"
          ? { jsonrpc: "2.0", id: "1", error: { code: 1, message: "Not found" } }
          : { jsonrpc: "2.0", id: "1", result: { version: "1.37.0" } },
    }));
    try {
      const engine = new Aria2Engine({
        rpc: new Aria2Rpc(`http://127.0.0.1:${fake.port}/jsonrpc`, "s3cret"),
      });
      await engine.start();
      await expect(engine.stats("nope")).resolves.toBeNull();
    } finally {
      fake.server.close();
    }
  });

  it("pause() is idempotent when the download is already paused", async () => {
    const fake = await fakeAria2Server(({ method }) => ({
      body:
        method === "aria2.pause"
          ? { jsonrpc: "2.0", id: "1", error: { code: 4, message: "Download already paused" } }
          : { jsonrpc: "2.0", id: "1", result: { version: "1.37.0" } },
    }));
    try {
      const engine = new Aria2Engine({
        rpc: new Aria2Rpc(`http://127.0.0.1:${fake.port}/jsonrpc`, "s3cret"),
      });
      await engine.start();
      await expect(engine.pause("g1")).resolves.toBeUndefined();
    } finally {
      fake.server.close();
    }
  });

  it("unpause() is idempotent when the download is already active", async () => {
    const fake = await fakeAria2Server(({ method }) => ({
      body:
        method === "aria2.unpause"
          ? { jsonrpc: "2.0", id: "1", error: { code: 5, message: "Download already active" } }
          : { jsonrpc: "2.0", id: "1", result: { version: "1.37.0" } },
    }));
    try {
      const engine = new Aria2Engine({
        rpc: new Aria2Rpc(`http://127.0.0.1:${fake.port}/jsonrpc`, "s3cret"),
      });
      await engine.start();
      await expect(engine.unpause("g1")).resolves.toBeUndefined();
    } finally {
      fake.server.close();
    }
  });

  it("remove() removes the download and its result record", async () => {
    const fake = await fakeAria2Server(() => ({
      body: { jsonrpc: "2.0", id: "1", result: "g1" },
    }));
    try {
      const engine = new Aria2Engine({
        rpc: new Aria2Rpc(`http://127.0.0.1:${fake.port}/jsonrpc`, "s3cret"),
      });
      await engine.start();
      await engine.remove("g1");
      expect(fake.requests.map((r) => r.method)).toEqual([
        "aria2.getVersion",
        "aria2.remove",
        "aria2.removeDownloadResult",
      ]);
    } finally {
      fake.server.close();
    }
  });

  it("start() rejects when the rpc endpoint is unreachable", async () => {
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const addr = probe.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    const port = addr.port;
    await new Promise<void>((r) => probe.close(() => r()));

    const engine = new Aria2Engine({
      rpc: new Aria2Rpc(`http://127.0.0.1:${port}/jsonrpc`, "s3cret"),
    });
    await expect(engine.start()).rejects.toThrow(/unreachable/);
  });
});

describe("Aria2Engine spawn mode", () => {
  it("spawns the binary with rpc args and waits for the readiness ping", async () => {
    const fake = await fakeAria2Server(() => ({
      body: { jsonrpc: "2.0", id: "1", result: { version: "1.37.0" } },
    }));
    const proc = fakeProc();
    const spawnImpl = vi.fn<(cmd: string, args: string[], opts: { windowsHide: boolean }) => Aria2Process>(() => proc);
    try {
      const engine = new Aria2Engine({
        binary: "C:/tools/aria2c.exe",
        secret: "testsecret",
        pickPort: () => fake.port,
        spawnImpl,
      });
      await engine.start();
      expect(spawnImpl).toHaveBeenCalledOnce();
      const [cmd, args, opts] = spawnImpl.mock.calls[0]!;
      expect(cmd).toBe("C:/tools/aria2c.exe");
      expect(args).toEqual(
        expect.arrayContaining([
          "--enable-rpc=true",
          `--rpc-listen-port=${fake.port}`,
          "--rpc-secret=testsecret",
          "--rpc-listen-all=false",
          "--max-concurrent-downloads=64",
          "--file-allocation=none",
        ]),
      );
      expect(opts).toMatchObject({ windowsHide: true });
      expect(fake.requests[0]!.method).toBe("aria2.getVersion");
    } finally {
      fake.server.close();
      proc.kill();
    }
  });

  it("retries with a fresh port when the first attempt cannot connect", async () => {
    const fake = await fakeAria2Server(() => ({
      body: { jsonrpc: "2.0", id: "1", result: { version: "1.37.0" } },
    }));
    const procs = [fakeProc(), fakeProc()];
    let spawnCount = 0;
    const spawnImpl = vi.fn<
      (cmd: string, args: string[], opts: { windowsHide: boolean }) => Aria2Process
    >(() => procs[spawnCount++]!);
    try {
      const engine = new Aria2Engine({
        binary: "aria2c",
        secret: "s",
        // First pick is a dead port, second is the live fake server.
        pickPort: (() => {
          let n = 0;
          return () => (n++ === 0 ? 39999 : fake.port);
        })(),
        spawnImpl,
      });
      await engine.start();
      expect(spawnImpl).toHaveBeenCalledTimes(2);
      expect(spawnImpl.mock.calls[0]![1]).toContain("--rpc-listen-port=39999");
      expect(spawnImpl.mock.calls[1]![1]).toContain(`--rpc-listen-port=${fake.port}`);
    } finally {
      fake.server.close();
      for (const p of procs) p.kill();
    }
  });

  it("fails with a clear message when the binary is missing (ENOENT)", async () => {
    const proc = fakeProc();
    const spawnImpl = vi.fn(() => {
      setImmediate(() => {
        const err = new Error("spawn aria2c ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        (proc as unknown as EventEmitter).emit("error", err);
      });
      return proc;
    });
    const engine = new Aria2Engine({ binary: "aria2c", secret: "s", spawnImpl });
    await expect(engine.start()).rejects.toThrow(/aria2c was not found/);
    proc.kill();
  });

  it("destroy() asks aria2 to shut down and kills the process", async () => {
    const fake = await fakeAria2Server(() => ({
      body: { jsonrpc: "2.0", id: "1", result: "OK" },
    }));
    const proc = fakeProc();
    const spawnImpl = vi.fn<(cmd: string, args: string[], opts: { windowsHide: boolean }) => Aria2Process>(() => proc);
    try {
      const engine = new Aria2Engine({
        binary: "aria2c",
        secret: "s",
        pickPort: () => fake.port,
        spawnImpl,
      });
      await engine.start();
      await engine.destroy();
      expect(fake.requests.map((r) => r.method)).toContain("aria2.shutdown");
      expect(proc.kill).toHaveBeenCalled();
    } finally {
      fake.server.close();
    }
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
