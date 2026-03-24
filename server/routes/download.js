import express from "express";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import fs from "fs";
import {
  getVideoInfo,
  getPlaylistInfo,
  downloadVideo,
  getDownloadPath,
  cleanupDownload,
  isPlaylistUrl,
} from "../utils/ytdlp.js";

const router = express.Router();

// Store active downloads
const activeDownloads = new Map();

// Clean up old downloads periodically (every 10 minutes)
setInterval(
  () => {
    const now = Date.now();
    for (const [id, data] of activeDownloads.entries()) {
      // Remove downloads older than 30 minutes
      if (now - data.timestamp > 30 * 60 * 1000) {
        if (data.path) {
          cleanupDownload(data.path);
        }
        activeDownloads.delete(id);
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

    const downloadId = uuidv4();
    const qualityHeight =
      quality === "audio" ? "audio" : quality.replace("p", "");

    // Store download status
    activeDownloads.set(downloadId, {
      status: "downloading",
      timestamp: Date.now(),
      path: null,
    });

    // Start download in background
    downloadVideo(url, qualityHeight, downloadId)
      .then((filePath) => {
        activeDownloads.set(downloadId, {
          status: "ready",
          timestamp: Date.now(),
          path: filePath,
        });
      })
      .catch((error) => {
        console.error("Download error:", error);
        activeDownloads.set(downloadId, {
          status: "error",
          timestamp: Date.now(),
          error: error.message,
          path: null,
        });
      });

    res.json({ downloadId, status: "started" });
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

  res.json({ status: download.status, error: download.error });
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
