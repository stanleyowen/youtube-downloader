import { spawn, execFileSync } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOWNLOADS_DIR = path.join(__dirname, "..", "downloads");
const MAX_STDERR_BUFFER = 256 * 1024;

// Resolve full yt-dlp path at startup so PM2's minimal PATH doesn't cause ENOENT.
function resolveYtDlpPath() {
  const candidates = [
    process.env.YTDLP_PATH,
    "/usr/local/bin/yt-dlp",
    `${process.env.HOME}/.local/bin/yt-dlp`,
    "/usr/bin/yt-dlp",
  ].filter(Boolean);

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  try {
    return execFileSync("which", ["yt-dlp"]).toString().trim();
  } catch {
    return "yt-dlp";
  }
}

const YTDLP_BIN = resolveYtDlpPath();
console.log(`[yt-dlp] using binary: ${YTDLP_BIN}`);

// Ensure downloads directory exists
if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

function appendLimited(target, chunk, maxLength) {
  const nextValue = target + chunk;
  if (nextValue.length <= maxLength) {
    return nextValue;
  }
  return nextValue.slice(nextValue.length - maxLength);
}

async function runYtDlp(args, options = {}) {
  const { captureStdout = true } = options;

  if (!Array.isArray(args) || args.length === 0) {
    throw new Error("yt-dlp arguments are required");
  }

  const BASE_ARGS = [
    "--user-agent",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  ];

  const runOnce = (extraArgs = []) =>
    new Promise((resolve, reject) => {
      const child = spawn(YTDLP_BIN, [...BASE_ARGS, ...extraArgs, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk) => {
        if (captureStdout) {
          stdout += chunk.toString();
        }
      });

      child.stderr.on("data", (chunk) => {
        stderr = appendLimited(stderr, chunk.toString(), MAX_STDERR_BUFFER);
      });

      child.on("error", (error) => {
        reject(error);
      });

      child.on("close", (code, signal) => {
        if (code === 0) {
          resolve(stdout);
          return;
        }

        console.error(`[yt-dlp] exit ${code}${signal ? ` signal:${signal}` : ""}\n${stderr}`);
        const err = new Error(
          `yt-dlp failed with exit code ${code}${signal ? ` (signal: ${signal})` : ""}`,
        );
        err.stderr = stderr;
        reject(err);
      });
    });

  try {
    return await runOnce();
  } catch (error) {
    const errorText = `${error?.message || ""}\n${error?.stderr || ""}`;
    if (/CERTIFICATE_VERIFY_FAILED|SSL: CERTIFICATE_VERIFY_FAILED/i.test(errorText)) {
      return runOnce(["--no-check-certificates"]);
    }

    throw error;
  }
}

export async function getVideoInfo(url) {
  try {
    const output = await runYtDlp(["--dump-json", "--no-playlist", "--", url]);
    const jsonLine = output.split("\n").find((l) => l.trim().startsWith("{"));
    if (!jsonLine) throw new Error("No JSON in yt-dlp output");
    const info = JSON.parse(jsonLine);
    return parseVideoInfo(info);
  } catch (error) {
    const detail = error.stderr ? `\n${error.stderr.trim()}` : "";
    const err = new Error(`Failed to get video info: ${error.message}${detail}`);
    err.stderr = error.stderr;
    throw err;
  }
}

export async function getPlaylistInfo(url) {
  try {
    const output = await runYtDlp([
      "--flat-playlist",
      "--dump-json",
      "-i",
      "--",
      url,
    ]);

    const videos = output
      .trim()
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    if (videos.length === 0) {
      throw new Error("No videos found in playlist");
    }

    return {
      isPlaylist: true,
      title: videos[0]?.playlist_title || "Playlist",
      videoCount: videos.length,
      videos: videos.map((v) => ({
        id: v.id,
        title: v.title,
        url: resolveEntryUrl(v),
        thumbnail: v.thumbnail || v.thumbnails?.[0]?.url || null,
        duration: v.duration ? formatDuration(v.duration) : "N/A",
      })),
    };
  } catch (error) {
    const detail = error.stderr ? `\n${error.stderr.trim()}` : "";
    const err = new Error(`Failed to get playlist info: ${error.message}${detail}`);
    err.stderr = error.stderr;
    throw err;
  }
}

function parseVideoInfo(info) {
  const formats = info.formats || [];

  // Get available video qualities
  const videoFormats = formats
    .filter((f) => f.vcodec !== "none" && f.acodec !== "none" && f.height)
    .reduce((acc, f) => {
      const height = f.height;
      if (
        !acc[height] ||
        (f.filesize && f.filesize > (acc[height].filesize || 0))
      ) {
        acc[height] = f;
      }
      return acc;
    }, {});

  // Get video-only formats for higher qualities
  const videoOnlyFormats = formats
    .filter((f) => f.vcodec !== "none" && f.acodec === "none" && f.height)
    .reduce((acc, f) => {
      const height = f.height;
      if (
        !acc[height] ||
        (f.filesize && f.filesize > (acc[height].filesize || 0))
      ) {
        acc[height] = f;
      }
      return acc;
    }, {});

  // Combine and create quality options
  const allHeights = new Set([
    ...Object.keys(videoFormats).map(Number),
    ...Object.keys(videoOnlyFormats).map(Number),
  ]);

  const qualities = Array.from(allHeights)
    .sort((a, b) => b - a)
    .map((height) => ({
      quality: `${height}p`,
      height,
      label: `${height}p${height >= 1080 ? " HD" : ""}`,
    }));

  // Add audio-only option
  qualities.push({
    quality: "audio",
    height: 0,
    label: "MP3 Audio",
  });

  return {
    isPlaylist: false,
    id: info.id,
    url: info.webpage_url || info.original_url || info.url,
    title: info.title,
    thumbnail: info.thumbnail,
    duration: formatDuration(info.duration),
    channel: info.channel || info.uploader,
    viewCount: info.view_count ? formatNumber(info.view_count) : null,
    qualities,
  };
}

function resolveEntryUrl(entry) {
  const directUrl = entry.webpage_url || entry.original_url || entry.url;

  if (typeof directUrl === "string" && /^https?:\/\//i.test(directUrl)) {
    return directUrl;
  }

  if (entry.extractor_key && typeof directUrl === "string" && directUrl) {
    // yt-dlp accepts extractor-prefixed URLs (for example, youtube:VIDEO_ID).
    return `${entry.extractor_key.toLowerCase()}:${directUrl}`;
  }

  return directUrl || "";
}

function formatDuration(seconds) {
  if (!seconds) return "0:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const hours = Math.floor(mins / 60);

  if (hours > 0) {
    return `${hours}:${String(mins % 60).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function formatNumber(num) {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + "M";
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(1) + "K";
  }
  return num.toString();
}

function sanitizeFilename(filename) {
  // Remove invalid filesystem characters and replace with underscore
  return filename
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 200); // Limit length to avoid filesystem issues
}

export async function downloadVideo(url, quality, downloadId) {
  // Get video info to extract the title
  const info = await getVideoInfo(url);
  const sanitizedTitle = sanitizeFilename(info.title || "video");
  const filePrefix = `${downloadId}-${sanitizedTitle}`;
  const outputPath = path.join(DOWNLOADS_DIR, `${filePrefix}.%(ext)s`);

  const args = ["--no-playlist", "-o", outputPath];

  if (quality === "audio") {
    args.push("-x", "--audio-format", "mp3", "--audio-quality", "0");
  } else {
    args.push(
      "-f",
      `bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]/bestvideo+bestaudio/best`,
      "--merge-output-format",
      "mp4",
    );
  }

  args.push("--", url);

  await runYtDlp(args, { captureStdout: false });

  // Find the downloaded file
  const files = fs.readdirSync(DOWNLOADS_DIR);
  const downloadedFiles = files
    .filter((f) => f.startsWith(filePrefix))
    .sort((a, b) => {
      const aTime = fs.statSync(path.join(DOWNLOADS_DIR, a)).mtimeMs;
      const bTime = fs.statSync(path.join(DOWNLOADS_DIR, b)).mtimeMs;
      return bTime - aTime;
    });
  const downloadedFile = downloadedFiles[0];

  if (!downloadedFile) {
    throw new Error("Download failed - file not found");
  }

  return path.join(DOWNLOADS_DIR, downloadedFile);
}

export function getDownloadPath(downloadId) {
  const files = fs.readdirSync(DOWNLOADS_DIR);
  const file = files.find((f) => f.startsWith(`${downloadId}-`));
  return file ? path.join(DOWNLOADS_DIR, file) : null;
}

export function cleanupDownload(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    console.error("Cleanup error:", error);
  }
}

export function isPlaylistUrl(url) {
  return url.includes("list=") || url.includes("/playlist");
}
