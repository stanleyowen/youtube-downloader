import express from "express";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import fs from "fs";
import {
  getVideoInfo,
  getPlaylistInfo,
  downloadVideo,
  cleanupDownload,
  isPlaylistUrl,
} from "../utils/ytdlp.js";

const router = express.Router();

// Store active downloads
const activeDownloads = new Map();
const pendingDownloads = [];
const MAX_CONCURRENT_DOWNLOADS =
  Number.parseInt(process.env.MAX_CONCURRENT_DOWNLOADS || "4", 10) || 4;
const MAX_QUEUE_SIZE =
  Number.parseInt(process.env.MAX_DOWNLOAD_QUEUE_SIZE || "500", 10) || 500;
const DOWNLOAD_RETRY_LIMIT =
  Number.parseInt(process.env.DOWNLOAD_RETRY_LIMIT || "1", 10) || 1;
const DOWNLOAD_TTL_MS = 30 * 60 * 1000;
const STALE_DOWNLOAD_MS = 2 * 60 * 60 * 1000;
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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(error) {
  const message = `${error?.message || ""}\n${error?.stderr || ""}`;
  return /ETIMEDOUT|ECONNRESET|ENOTFOUND|429|500|502|503|network|temporarily unavailable|timeout/i.test(
    message,
  );
}

async function runDownloadTask(task) {
  const { downloadId, url, quality } = task;
  updateDownload(downloadId, { status: "downloading", startedAt: Date.now() });

  for (let attempt = 0; attempt <= DOWNLOAD_RETRY_LIMIT; attempt += 1) {
    try {
      const filePath = await downloadVideo(url, quality, downloadId);
      updateDownload(downloadId, {
        status: "ready",
        completedAt: Date.now(),
        path: filePath,
        error: null,
      });
      return;
    } catch (error) {
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

// Get video/playlist info
router.post("/info", async (req, res) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ error: "URL is required" });
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
    const { url, quality } = req.body;

    if (!url) {
      return res.status(400).json({ error: "URL is required" });
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

    // Store download status and enqueue work.
    activeDownloads.set(downloadId, {
      status: "queued",
      timestamp: Date.now(),
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

// Check download status
router.get("/status/:id", (req, res) => {
  const { id } = req.params;
  const download = activeDownloads.get(id);

  if (!download) {
    return res.status(404).json({ error: "Download not found" });
  }

  res.json({
    status: download.status,
    error: download.error,
    queuePosition: download.status === "queued" ? getQueuePosition(id) : null,
  });
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
