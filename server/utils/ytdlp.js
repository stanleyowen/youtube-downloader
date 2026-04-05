import { exec } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOWNLOADS_DIR = path.join(__dirname, "..", "downloads");

// Ensure downloads directory exists
if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

async function runYtDlp(args) {
  const buildCommand = (extraArgs = []) =>
    `yt-dlp ${[...extraArgs, ...args].map((a) => `"${a}"`).join(" ")}`;

  try {
    const { stdout } = await execAsync(buildCommand(), {
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const errorText = `${error?.message || ""}\n${error?.stderr || ""}`;
    const hasSslError =
      /CERTIFICATE_VERIFY_FAILED|SSL: CERTIFICATE_VERIFY_FAILED/i.test(
        errorText,
      );

    if (hasSslError) {
      const { stdout } = await execAsync(
        buildCommand(["--no-check-certificates"]),
        {
          maxBuffer: 10 * 1024 * 1024,
        },
      );
      return stdout;
    }

    throw error;
  }
}

export async function getVideoInfo(url) {
  try {
    const output = await runYtDlp([url, "--dump-json", "--no-playlist"]);
    const info = JSON.parse(output);
    return parseVideoInfo(info);
  } catch (error) {
    throw new Error(`Failed to get video info: ${error.message}`);
  }
}

export async function getPlaylistInfo(url) {
  try {
    const output = await runYtDlp([
      url,
      "--flat-playlist",
      "--dump-json",
      "-i",
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
    throw new Error(`Failed to get playlist info: ${error.message}`);
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
  const sanitizedTitle = sanitizeFilename(info.title);

  const outputPath = path.join(DOWNLOADS_DIR, `${sanitizedTitle}.%(ext)s`);

  const args = [url, "-o", outputPath];

  if (quality === "audio") {
    args.push("-x", "--audio-format", "mp3", "--audio-quality", "0");
  } else {
    // Prefer MP4 video + M4A audio, then fall back to any format that still has audio.
    args.push(
      "-f",
      `bestvideo[ext=mp4][height<=${quality}]+bestaudio[ext=m4a]/best[ext=mp4][height<=${quality}][acodec!=none]/bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}][acodec!=none]/best[acodec!=none]`,
      "--merge-output-format",
      "mp4",
    );
  }

  await runYtDlp(args);

  // Find the downloaded file
  const files = fs.readdirSync(DOWNLOADS_DIR);
  const downloadedFile = files.find((f) => f.startsWith(sanitizedTitle));

  if (!downloadedFile) {
    throw new Error("Download failed - file not found");
  }

  return path.join(DOWNLOADS_DIR, downloadedFile);
}

export function getDownloadPath(downloadId) {
  const files = fs.readdirSync(DOWNLOADS_DIR);
  const file = files.find((f) => f.startsWith(downloadId));
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
