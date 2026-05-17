import { spawn } from "child_process";

const MAX_STDERR_BUFFER = 256 * 1024;

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

  const runOnce = (extraArgs = []) =>
    new Promise((resolve, reject) => {
      const process = spawn("yt-dlp", [...extraArgs, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      process.stdout.on("data", (chunk) => {
        if (captureStdout) {
          stdout += chunk.toString();
        }
      });

      process.stderr.on("data", (chunk) => {
        stderr = appendLimited(stderr, chunk.toString(), MAX_STDERR_BUFFER);
      });

      process.on("error", (error) => {
        reject(error);
      });

      process.on("close", (code, signal) => {
        if (code === 0) {
          resolve(stdout);
          return;
        }

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
  return filename
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 200);
}

function buildStreamArgs(url, quality) {
  const args = [url, "--no-playlist", "-o", "-", "--no-part", "--quiet", "--no-warnings"];

  if (quality === "audio") {
    args.push("-x", "--audio-format", "mp3", "--audio-quality", "0");
  } else {
    args.push(
      "-f",
      `bestvideo[ext=mp4][height<=${quality}]+bestaudio[ext=m4a]/best[ext=mp4][height<=${quality}][acodec!=none]/bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}][acodec!=none]/best[acodec!=none]`,
      "--merge-output-format", "mp4",
      // Make mp4 streamable to stdout (fragmented moov so ffmpeg doesn't need to seek).
      "--postprocessor-args", "Merger:-movflags +frag_keyframe+empty_moov+default_base_moof",
    );
  }

  return args;
}

export async function streamDownload(url, quality, response) {
  const info = await getVideoInfo(url);
  const sanitizedTitle = sanitizeFilename(info.title || "video");
  const extension = quality === "audio" ? "mp3" : "mp4";
  const filename = `${sanitizedTitle}.${extension}`;
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, "_");

  response.setHeader(
    "Content-Type",
    quality === "audio" ? "audio/mpeg" : "video/mp4",
  );
  response.setHeader(
    "Content-Disposition",
    `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
  );

  const args = buildStreamArgs(url, quality);

  await new Promise((resolve, reject) => {
    const proc = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let settled = false;

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    proc.stderr.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk.toString(), MAX_STDERR_BUFFER);
    });

    proc.stdout.on("error", () => {
      // Client disconnect causes EPIPE here; handled via response.close below.
    });

    proc.stdout.pipe(response);

    proc.on("error", (err) => settle(reject, err));

    proc.on("close", (code, signal) => {
      if (code === 0) {
        settle(resolve);
        return;
      }
      const err = new Error(
        `yt-dlp failed with exit code ${code}${signal ? ` (signal: ${signal})` : ""}`,
      );
      err.stderr = stderr;
      settle(reject, err);
    });

    response.on("close", () => {
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill("SIGTERM");
      }
    });
  });
}

export function isPlaylistUrl(url) {
  return url.includes("list=") || url.includes("/playlist");
}
