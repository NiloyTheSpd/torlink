'use strict';

// Downloads the official yt-dlp standalone binary from GitHub Releases so
// video and playlist downloads work out of the box after `npm install` /
// `npx torlnk`. npm runs this package's postinstall, which fetches the
// platform-appropriate prebuilt executable into vendor/yt-dlp/.
//
// Failure only warns and never fails the install: torlink still runs, and
// video downloads fall back to a system `yt-dlp` or `python -m yt_dlp`.

const { createWriteStream, existsSync, mkdirSync, renameSync, chmodSync, unlinkSync } =
  require('node:fs');
const { get } = require('node:https');
const { join } = require('node:path');
const { platform, arch } = require('node:os');

const ASSET =
  platform() === 'win32'
    ? 'yt-dlp.exe'
    : platform() === 'darwin'
      ? 'yt-dlp_macos'
      : platform() === 'linux' && arch() === 'x64'
        ? 'yt-dlp_linux'
        : platform() === 'linux' && arch() === 'arm64'
          ? 'yt-dlp_linux_aarch64'
          : 'yt-dlp';

const DIR = join(__dirname, '..', 'vendor', 'yt-dlp');
const TARGET = join(DIR, ASSET);
const TMP = `${TARGET}.part`;

if (existsSync(TARGET)) {
  process.exit(0);
}

const RELEASE_URL = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${ASSET}`;

function download(url, redirects) {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) {
          reject(new Error('too many redirects'));
          return;
        }
        resolve(download(new URL(res.headers.location, url).toString(), redirects - 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const out = createWriteStream(TMP);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve()));
      out.on('error', reject);
      res.on('error', reject);
    }).on('error', reject);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// GitHub is occasionally unreachable from some networks; retry a few times
// before giving up.
async function downloadWithRetry() {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await download(RELEASE_URL, 5);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(2000 * attempt);
    }
  }
  throw lastError;
}

(async () => {
  try {
    mkdirSync(DIR, { recursive: true });
    await downloadWithRetry();
    try {
      chmodSync(TMP, 0o755);
    } catch {
      // Windows has no chmod; harmless.
    }
    renameSync(TMP, TARGET);
    console.error(`torlnk: bundled yt-dlp (${ASSET}).`);
  } catch (error) {
    try {
      unlinkSync(TMP);
    } catch {
      // Nothing to clean up.
    }
    console.error('');
    console.error('torlnk: could not download yt-dlp.');
    console.error('Video downloads will fall back to a system yt-dlp or python yt_dlp.');
    console.error(`  ${error.message}`);
    console.error('');
  }
  process.exit(0);
})();
