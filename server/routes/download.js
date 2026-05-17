import express from "express";
import {
  getVideoInfo,
  getPlaylistInfo,
  streamDownload,
  isPlaylistUrl,
} from "../utils/ytdlp.js";

const router = express.Router();

const MAX_CONCURRENT_DOWNLOADS =
  Number.parseInt(process.env.MAX_CONCURRENT_DOWNLOADS || "4", 10) || 4;
let runningDownloads = 0;

router.post("/info", async (req, res) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ error: "URL is required" });
    }

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

router.get("/download", async (req, res) => {
  const { url, quality } = req.query;

  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "URL is required" });
  }

  if (runningDownloads >= MAX_CONCURRENT_DOWNLOADS) {
    return res.status(503).json({
      error: "Server is busy. Please try again shortly.",
    });
  }

  const requestedQuality =
    quality === "audio" || /^\d+p$/.test(quality || "") ? quality : "720p";
  const qualityHeight =
    requestedQuality === "audio" ? "audio" : requestedQuality.replace("p", "");

  runningDownloads += 1;
  try {
    await streamDownload(url, qualityHeight, res);
  } catch (error) {
    console.error("Stream error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    } else {
      // Headers already flushed — abort the connection so the client knows the
      // payload is truncated rather than complete.
      res.destroy(error);
    }
  } finally {
    runningDownloads = Math.max(0, runningDownloads - 1);
  }
});

export default router;
