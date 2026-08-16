import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { YtDlpEngine, parseYtDlpLine, type YtDlpProcess } from "./ytdlp";

describe("parseYtDlpLine", () => {
  it("parses a full progress line: percent, size, speed, eta", () => {
    const out = parseYtDlpLine("[download]  42.3% of    1.00MiB at    2.50MiB/s ETA 00:12");
    expect(out).toMatchObject({ kind: "progress", progress: 42.3, totalBytes: 1024 ** 2, speed: 2.5 * 1024 ** 2, eta: 12 });
  });

  it("parses hour-long etas and approximate (~) sizes", () => {
    const out = parseYtDlpLine("[download]  10.0% of  ~2.00GiB at    5.00MiB/s ETA 01:02:03");
    expect(out).toMatchObject({ totalBytes: 2 * 1024 ** 3, speed: 5 * 1024 ** 2, eta: 3723 });
  });

  it("tolerates unknown speed and missing eta", () => {
    const out = parseYtDlpLine("[download]   0.0% of    1.00MiB at  Unknown B/s");
    expect(out).toMatchObject({ kind: "progress", progress: 0, totalBytes: 1024 ** 2 });
    expect(out!.speed).toBeUndefined();
    expect(out!.eta).toBeUndefined();
  });

  it("ignores non-progress lines", () => {
    expect(parseYtDlpLine("[youtube] Extracting URL: https://x")).toBeNull();
    expect(parseYtDlpLine("[Merger] Merging formats into \"a.mp4\"")).toBeNull();
    expect(parseYtDlpLine("")).toBeNull();
  });

  it("tracks playlist position for honest overall progress", () => {
    expect(parseYtDlpLine("[download] Downloading item 2 of 4")).toEqual({
      kind: "item",
      item: 2,
      count: 4,
    });
    // Half of file 2 of 4 → overall 37.5%.
    const out = parseYtDlpLine("[download]  50.0% of    1.00MiB at    1.00MiB/s", {
      item: 2,
      count: 4,
    });
    expect(out).toMatchObject({ progress: 37.5 });
  });
});

// A controllable stand-in for a spawned yt-dlp: stdout/stderr are real
// PassThroughs so the engine's stream wiring runs for real.
class FakeProc {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  private closeHandlers: Array<(code: number | null, signal: string | null) => void> = [];
  private errorHandlers: Array<(err: Error) => void> = [];

  line(s: string): void {
    this.stdout.write(`${s}\n`);
  }
  errLine(s: string): void {
    this.stderr.write(`${s}\n`);
  }
  kill(): void {
    this.killed = true;
    this.close(null, "SIGTERM");
  }
  close(code: number | null, signal: string | null = null): void {
    for (const h of this.closeHandlers.splice(0)) h(code, signal);
  }
  fail(err: Error): void {
    for (const h of this.errorHandlers.splice(0)) h(err);
  }
  once(event: "error" | "close", listener: (...args: never[]) => void): this {
    if (event === "close") this.closeHandlers.push(listener as never);
    else this.errorHandlers.push(listener as never);
    return this;
  }
}

interface Launched {
  proc: FakeProc;
  cmd: string;
  args: string[];
}

function engineWith(
  behavior: (l: Launched) => void = () => {},
): { engine: YtDlpEngine; launched: Launched[] } {
  const launched: Launched[] = [];
  const engine = new YtDlpEngine({
    spawnImpl: (cmd, args) => {
      const proc = new FakeProc();
      launched.push({ proc, cmd, args });
      behavior(launched[launched.length - 1]!);
      return proc as unknown as YtDlpProcess;
    },
  });
  return { engine, launched };
}

const SPEC = { url: "https://example.com/watch?v=x", formatId: "22" };

describe("YtDlpEngine", () => {
  it("spawns with --newline progress output and the chosen format", () => {
    const { engine, launched } = engineWith();
    expect(engine.add("v1", SPEC, "C:/dl")).toBe(true);
    expect(launched).toHaveLength(1);
    expect(launched[0]!.args).toContain("--newline");
    expect(launched[0]!.args).toContain("-f");
    expect(launched[0]!.args).toContain("22");
    expect(launched[0]!.args.at(-1)).toBe(SPEC.url);
    expect(launched[0]!.args.join(" ")).toContain("C:/dl/%(title)s.%(ext)s".replaceAll("\\", "/"));
  });

  it("converts audio downloads with a bestaudio/best fallback", () => {
    const { engine, launched } = engineWith();
    engine.add("v1", { url: SPEC.url, audioMp3: true }, "/tmp");
    const args = launched[0]!.args;
    const i = args.indexOf("-f");
    expect(args[i + 1]).toBe("bestaudio/best");
    expect(args).toContain("-x");
  });

  it("returns false when no candidate can spawn", () => {
    const engine = new YtDlpEngine({
      spawnImpl: () => {
        throw new Error("ENOENT");
      },
    });
    expect(engine.add("v1", SPEC, "/tmp")).toBe(false);
  });

  it("exposes parsed progress through stats()", () => {
    const { engine, launched } = engineWith();
    engine.add("v1", SPEC, "/tmp");
    launched[0]!.proc.line("[download]  25.0% of    4.00MiB at    1.00MiB/s ETA 00:09");
    expect(engine.stats("v1")).toMatchObject({
      status: "running",
      progress: 25,
      totalBytes: 4 * 1024 ** 2,
      downloadedBytes: 1024 ** 2,
      speed: 1024 ** 2,
      eta: 9,
    });
  });

  it("marks complete on exit 0 with progress pinned to 100", () => {
    const { engine, launched } = engineWith();
    engine.add("v1", SPEC, "/tmp");
    launched[0]!.proc.line("[download]  90.0% of    4.00MiB at  Unknown B/s");
    launched[0]!.proc.close(0);
    expect(engine.stats("v1")).toMatchObject({ status: "complete", progress: 100 });
  });

  it("fails with the last ERROR line when yt-dlp exits nonzero", () => {
    const { engine, launched } = engineWith();
    engine.add("v1", SPEC, "/tmp");
    launched[0]!.proc.errLine("ERROR: [youtube] xyz: Video unavailable");
    launched[0]!.proc.close(1);
    expect(engine.stats("v1")).toMatchObject({
      status: "error",
      error: "[youtube] xyz: Video unavailable",
    });
  });

  it("fails with the exit code when stderr carries no ERROR line", () => {
    const { engine, launched } = engineWith();
    engine.add("v1", SPEC, "/tmp");
    launched[0]!.proc.close(2);
    expect(engine.stats("v1")).toMatchObject({ status: "error", error: "yt-dlp exited with code 2." });
  });

  it("pause and remove kill the process and drop the handle", () => {
    const { engine, launched } = engineWith();
    engine.add("v1", SPEC, "/tmp");
    const proc = launched[0]!.proc;
    engine.pause("v1");
    expect(proc.killed).toBe(true);
    expect(engine.stats("v1")).toBeNull();

    engine.add("v2", SPEC, "/tmp"); // re-add spawns fresh after a pause
    expect(launched).toHaveLength(2);
    engine.destroy();
    expect(launched[1]!.proc.killed).toBe(true);
    expect(engine.stats("v2")).toBeNull();
  });
});
