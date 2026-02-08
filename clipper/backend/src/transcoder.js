import { dequeueJobSilent, queueJob } from "./infra/redis.js";
import { downloadFile, uploadFile } from "./infra/s3.js";
import { updateVideoStatus, updateJobStatus } from "./models/videoModel.js";
import { log } from "./utils/log.js";

async function processJob(job) {
  const { jobId, videoId, key } = job;

  log("info", { event: "transcode_started", jobId, videoId });

  try {
    await updateJobStatus(jobId, "processing");
    await updateVideoStatus(videoId, "processing");

    const videoStream = await downloadFile(key);

    await new Promise(resolve => setTimeout(resolve, 2000));

    const transcodedKey = key.replace("uploads/", "transcoded/");
    const chunks = [];
    for await (const chunk of videoStream) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    await uploadFile(transcodedKey, buffer, "video/mp4");

    await updateJobStatus(jobId, "completed");
    await updateVideoStatus(videoId, "completed");

    // Try to queue notification - log specific error if Redis is down
    try {
      await queueJob("notification_jobs", {
        type: "transcode_complete",
        videoId,
        filename: key.split("/").pop()
      });
    } catch (notifyErr) {
      log("error", {
        error_code: "NOTIFICATION_QUEUE_FAILED",
        message: notifyErr.message,
        jobId,
        videoId
      });
    }

    log("info", { event: "transcode_completed", jobId, videoId });
  } catch (err) {
    log("error", {
      error_code: "TRANSCODE_FAILED",
      message: err.message,
      jobId,
      videoId
    });

    try {
      await updateJobStatus(jobId, "failed", err.message);
      await updateVideoStatus(videoId, "failed");
    } catch (updateErr) {
      log("error", {
        error_code: "STATUS_UPDATE_FAILED",
        message: updateErr.message
      });
    }
  }
}

async function main() {
  log("info", { event: "transcoder_started" });

  while (true) {
    const job = await dequeueJobSilent("transcode_jobs");
    if (job) {
      await processJob(job);
    }
  }
}

main();
