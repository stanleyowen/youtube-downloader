import express from "express";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import fs from "fs";
import {
  getVideoInfo,
  getPlaylistInfo,
  downloadVideo,
  cleanupDownload,
  deleteDownloadFiles,
  isPlaylistUrl,
} from "../utils/ytdlp.js";

const router = express.Router();

// Store active downloads
const activeDownloads = new Map();
const pendingDownloads = [];
// AbortController per in-flight download so we can kill the yt-dlp process.
const abortControllers = new Map();
const MAX_CONCURRENT_DOWNLOADS =
  Number.parseInt(process.env.MAX_CONCURRENT_DOWNLOADS || "4", 10) || 4;
const MAX_QUEUE_SIZE =
  Number.parseInt(process.env.MAX_DOWNLOAD_QUEUE_SIZE || "500", 10) || 500;
const DOWNLOAD_RETRY_LIMIT =
  Number.parseInt(process.env.DOWNLOAD_RETRY_LIMIT || "1", 10) || 1;
const DOWNLOAD_TTL_MS = 30 * 60 * 1000;
const STALE_DOWNLOAD_MS = 2 * 60 * 60 * 1000;
// If the client stops polling /status for this long, treat the download as
// abandoned: kill the process and delete the files.
const ABANDON_MS =
  Number.parseInt(process.env.DOWNLOAD_ABANDON_MS || "45000", 10) || 45000;
let runningDownloads = 0;

function updateDownload(id, updates) {
  const existing = activeDownloads.get(id);
  if (!existing) {
    return;
  }

  activeDownloads.set(id, {
    ...existing,
    ...updates,
    timestamp: Date.now(),
  });
}

function getQueuePosition(downloadId) {
  const index = pendingDownloads.findIndex((task) => task.downloadId === downloadId);
  return index >= 0 ? index + 1 : null;
}

// Cancel a download from any state: drop it from the queue, kill a running
// yt-dlp process, and delete any files it produced.
function cancelDownload(id, reason = "cancelled") {
  const data = activeDownloads.get(id);
  if (!data) {
    return false;
  }

  // The file is being streamed to a client right now — let the transfer and
  // its own post-serve cleanup finish.
  if (data.serving) {
    return false;
  }

  // Mark cancelled so the running task loop won't retry or overwrite status.
  activeDownloads.set(id, { ...data, cancelled: true });

  // Remove it from the pending queue if it never started.
  const queueIndex = pendingDownloads.findIndex((t) => t.downloadId === id);
  if (queueIndex >= 0) {
    pendingDownloads.splice(queueIndex, 1);
  }

  const controller = abortControllers.get(id);
  if (controller) {
    // A process is running: abort it. runDownloadTask's finally block deletes
    // the partial files and the map entry once the process has fully exited.
    controller.abort();
    console.log(`[download] ${id} ${reason}: aborting process`);
    return true;
  }

  // No running process (queued or already finished): clean up directly.
  deleteDownloadFiles(id);
  activeDownloads.delete(id);
  console.log(`[download] ${id} ${reason}: removed`);
  return true;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Reject anything that isn't a plain http(s) URL (or an extractor-prefixed id
// like "youtube:VIDEO_ID" from playlist entries). Values starting with "-"
// would otherwise be parsed by yt-dlp as options — including --exec, which
// runs arbitrary shell commands.
const PRIVATE_HOST_PATTERN =
  /^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/i;

function validateTargetUrl(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) {
    return null;
  }

  if (!/^https?:/i.test(raw)) {
    return /^[a-z][a-z0-9_]*:[\w-]+$/i.test(raw) ? raw : null;
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  if (PRIVATE_HOST_PATTERN.test(parsed.hostname)) {
    return null;
  }

  return parsed.href;
}

function isRetryableError(error) {
  const message = `${error?.message || ""}\n${error?.stderr || ""}`;
  return /ETIMEDOUT|ECONNRESET|ENOTFOUND|429|500|502|503|network|temporarily unavailable|timeout/i.test(
    message,
  );
}

function isCancelled(downloadId) {
  return activeDownloads.get(downloadId)?.cancelled === true;
}

async function runDownloadTask(task) {
  const { downloadId, url, quality } = task;
  const controller = new AbortController();
  abortControllers.set(downloadId, controller);
  updateDownload(downloadId, { status: "downloading", startedAt: Date.now() });

  try {
    for (let attempt = 0; attempt <= DOWNLOAD_RETRY_LIMIT; attempt += 1) {
      if (isCancelled(downloadId)) {
        return;
      }

      try {
        const filePath = await downloadVideo(
          url,
          quality,
          downloadId,
          controller.signal,
        );
        if (isCancelled(downloadId)) {
          return;
        }
        updateDownload(downloadId, {
          status: "ready",
          completedAt: Date.now(),
          path: filePath,
          error: null,
        });
        return;
      } catch (error) {
        // The download was aborted by cancelDownload — stop silently; the
        // finally block deletes any partial files.
        if (error?.aborted || controller.signal.aborted || isCancelled(downloadId)) {
          return;
        }

        const isLastAttempt = attempt >= DOWNLOAD_RETRY_LIMIT;

        if (!isLastAttempt && isRetryableError(error)) {
          updateDownload(downloadId, {
            status: "retrying",
            error: `Retrying download (${attempt + 1}/${DOWNLOAD_RETRY_LIMIT})`,
          });
          await wait(1500 * (attempt + 1));
          continue;
        }

        updateDownload(downloadId, {
          status: "error",
          error: error.message,
          path: null,
        });
        return;
      }
    }
  } finally {
    abortControllers.delete(downloadId);
    // If cancelled, the process has now fully exited, so it's safe to remove
    // any partial files and drop the record.
    if (isCancelled(downloadId)) {
      deleteDownloadFiles(downloadId);
      activeDownloads.delete(downloadId);
    }
  }
}

function processQueue() {
  while (
    runningDownloads < MAX_CONCURRENT_DOWNLOADS &&
    pendingDownloads.length > 0
  ) {
    const nextTask = pendingDownloads.shift();
    const tracked = nextTask ? activeDownloads.get(nextTask.downloadId) : null;

    if (!nextTask || !tracked || tracked.status !== "queued") {
      continue;
    }

    runningDownloads += 1;
    runDownloadTask(nextTask)
      .catch((error) => {
        updateDownload(nextTask.downloadId, {
          status: "error",
          error: error.message,
          path: null,
        });
      })
      .finally(() => {
        runningDownloads = Math.max(0, runningDownloads - 1);
        processQueue();
      });
  }
}

// Clean up old downloads periodically (every 10 minutes)
setInterval(
  () => {
    const now = Date.now();
    for (const [id, data] of activeDownloads.entries()) {
      // Remove completed/error downloads older than 30 minutes.
      if (
        ["ready", "error"].includes(data.status) &&
        now - data.timestamp > DOWNLOAD_TTL_MS
      ) {
        if (data.path) {
          cleanupDownload(data.path);
        }
        activeDownloads.delete(id);
        continue;
      }

      // Mark stale active downloads as failed so clients stop polling forever.
      if (
        ["queued", "downloading", "retrying"].includes(data.status) &&
        now - data.timestamp > STALE_DOWNLOAD_MS
      ) {
        activeDownloads.set(id, {
          ...data,
          status: "error",
          error: "Download timed out while processing",
          path: null,
          timestamp: now,
        });
      }
    }
  },
  10 * 60 * 1000,
);

// Detect abandoned downloads: the client polls /status every second, so a long
// gap means it navigated away or refreshed. Kill the process and delete files.
setInterval(() => {
  const now = Date.now();
  for (const [id, data] of activeDownloads.entries()) {
    // Never interrupt a file that's actively being streamed to a client.
    if (data.serving) {
      continue;
    }

    const lastSeen = data.lastPolledAt || data.timestamp;
    if (now - lastSeen > ABANDON_MS) {
      cancelDownload(id, "abandoned by client");
    }
  }
}, 10 * 1000);

// Get video/playlist info
router.post("/info", async (req, res) => {
  try {
    const url = validateTargetUrl(req.body?.url);

    if (!url) {
      return res.status(400).json({ error: "A valid http(s) URL is required" });
    }

    // Check if it's a playlist
    if (isPlaylistUrl(url)) {
      const info = await getPlaylistInfo(url);
      return res.json(info);
    }

    const info = await getVideoInfo(url);
    res.json(info);
  } catch (error) {
    console.error("Info error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Start download and return download ID
router.post("/download", async (req, res) => {
  try {
    const { quality } = req.body;
    const url = validateTargetUrl(req.body?.url);

    if (!url) {
      return res.status(400).json({ error: "A valid http(s) URL is required" });
    }

    if (pendingDownloads.length >= MAX_QUEUE_SIZE) {
      return res.status(503).json({
        error: "Server is busy. Please try again shortly.",
      });
    }

    const downloadId = uuidv4();
    const requestedQuality =
      quality === "audio" || /^\d+p$/.test(quality || "") ? quality : "720p";
    const qualityHeight =
      requestedQuality === "audio" ? "audio" : requestedQuality.replace("p", "");

    // Store download status and enqueue work. Seed lastPolledAt so the
    // abandonment sweep gives the client a moment to start polling.
    activeDownloads.set(downloadId, {
      status: "queued",
      timestamp: Date.now(),
      lastPolledAt: Date.now(),
      path: null,
      error: null,
    });

    pendingDownloads.push({
      downloadId,
      url,
      quality: qualityHeight,
      createdAt: Date.now(),
    });
    processQueue();

    res.json({
      downloadId,
      status: "queued",
      queuePosition: getQueuePosition(downloadId),
    });
  } catch (error) {
    console.error("Download init error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Check download status. Each poll doubles as a heartbeat: recording the time
// lets the abandonment sweep tell an active client from a departed one.
router.get("/status/:id", (req, res) => {
  const { id } = req.params;
  const download = activeDownloads.get(id);

  if (!download) {
    return res.status(404).json({ error: "Download not found" });
  }

  if (!download.serving) {
    download.lastPolledAt = Date.now();
  }

  res.json({
    status: download.status,
    error: download.error,
    queuePosition: download.status === "queued" ? getQueuePosition(id) : null,
  });
});

// Explicit cancel — the client fires this via navigator.sendBeacon on page
// unload for instant cleanup instead of waiting for the abandonment sweep.
router.post("/cancel/:id", (req, res) => {
  const { id } = req.params;
  const existed = cancelDownload(id, "cancel request");
  res.json({ cancelled: existed });
});

// Serve downloaded file
router.get("/file/:id", (req, res) => {
  const { id } = req.params;
  const download = activeDownloads.get(id);

  if (!download || download.status !== "ready") {
    return res.status(404).json({ error: "File not ready or not found" });
  }

  const filePath = download.path;

  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found" });
  }

  // Mark as serving so the abandonment sweep won't delete the file mid-stream.
  download.serving = true;

  const filename = path.basename(filePath);
  res.download(filePath, filename, (err) => {
    if (err) {
      console.error("Download serve error:", err);
    }
    // Clean up after download
    setTimeout(() => {
      cleanupDownload(filePath);
      activeDownloads.delete(id);
    }, 5000);
  });
});

export default router;
