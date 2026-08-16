// Live smoke: a real yt-dlp download through the DownloadQueue video path.
// Serves a small file over localhost, queues it as a video item, and asserts
// live progress, completion, the on-disk file, and a history entry.

import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "torlink-video-smoke-"));
process.env.TORLINK_STATE_DIR = stateDir;

const outDir = path.join(stateDir, "dl");
await fs.mkdir(outDir, { recursive: true });

// ~2 MB of pseudo-random payload.
const payload = Buffer.alloc(2 * 1024 * 1024);
for (let i = 0; i < payload.length; i += 8) payload.writeBigUInt64BE(BigInt(i) * 2654435761n, i);

const server = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": payload.length });
  res.end(payload);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
const url = `http://127.0.0.1:${port}/clip.mp4`;

const { DownloadQueue } = await import("../src/download/queue");
const q = new DownloadQueue();

let done = false;
q.on("completed", () => (done = true));

const out = q.addVideo({ url, name: "smoke clip", dir: outDir });
console.log(`added=${out.added} name=${out.name}`);

const deadline = Date.now() + 90_000;
while (!done && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 500));
  const it = q.getItems()[0];
  if (it) {
    console.log(
      `${it.status}  ${it.progress}%  ${it.downloadedBytes}/${it.totalBytes}B  ${Math.round(it.speed)}B/s`,
    );
  }
}

q.suspend();
server.close();

const hist = q.getHistory();
const files = await fs.readdir(outDir);
console.log("history:", JSON.stringify(hist.map((h) => ({ name: h.name, url: h.url, video: h.video, size: h.sizeBytes }))));
console.log("files:", files.join(", "));

const ok =
  done &&
  hist.length === 1 &&
  hist[0]!.video?.url === url &&
  hist[0]!.sizeBytes === payload.length &&
  files.length === 1 &&
  (await fs.stat(path.join(outDir, files[0]!))).size === payload.length;

await fs.rm(stateDir, { recursive: true, force: true });
console.log(ok ? "SMOKE OK" : "SMOKE FAILED");
process.exit(ok ? 0 : 1);
