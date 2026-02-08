import { createVideo, getVideo, getAllVideos, createJob } from "../models/videoModel.js";
import { uploadFile } from "../infra/s3.js";
import { queueJob } from "../infra/redis.js";
import { log } from "../utils/log.js";

export async function uploadVideo(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const { originalname, buffer, mimetype } = req.file;
    const key = `uploads/${Date.now()}-${originalname}`;

    await uploadFile(key, buffer, mimetype);

    const video = await createVideo(originalname, key);

    const job = await createJob(video.id, "transcode");

    await queueJob("transcode_jobs", {
      jobId: job.id,
      videoId: video.id,
      key
    });

    log("info", {
      event: "video_uploaded",
      videoId: video.id,
      filename: originalname
    });

    res.status(201).json({ video, job });
  } catch (err) {
    log("error", {
      error_code: "VIDEO_UPLOAD_FAILED",
      message: err.message
    });
    res.status(500).json({ error: "Upload failed", details: err.message });
  }
}

export async function getVideoById(req, res) {
  try {
    const video = await getVideo(req.params.id);
    if (!video) {
      return res.status(404).json({ error: "Video not found" });
    }
    res.json(video);
  } catch (err) {
    log("error", {
      error_code: "VIDEO_FETCH_FAILED",
      message: err.message,
      videoId: req.params.id
    });
    res.status(500).json({ error: "Failed to fetch video" });
  }
}

export async function listVideos(req, res) {
  try {
    const videos = await getAllVideos();
    res.json(videos);
  } catch (err) {
    log("error", {
      error_code: "VIDEO_LIST_FAILED",
      message: err.message
    });
    res.status(500).json({ error: "Failed to list videos" });
  }
}
