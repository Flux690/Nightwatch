import nodemailer from "nodemailer";
import { dequeueJobSilent } from "./infra/redis.js";
import { updateJobStatus, createJob } from "./models/videoModel.js";
import { log } from "./utils/log.js";

function createTransporter() {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || "1025", 10);

  if (!host) {
    throw new Error("SMTP_HOST environment variable is not set");
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: false
  });
}

async function processNotification(notification) {
  const { videoId, filename } = notification;

  log("info", { event: "notification_started", videoId });

  try {
    const job = await createJob(videoId, "notify");

    const transporter = createTransporter();

    const subject = `Video "${filename}" processed successfully`;
    const text = `Your video (ID: ${videoId}) has been transcoded and is ready for viewing.`;

    await transporter.sendMail({
      from: "clipper@example.com",
      to: "user@example.com",
      subject,
      text
    });

    await updateJobStatus(job.id, "completed");

    log("info", { event: "notification_sent", videoId });
  } catch (err) {
    log("error", {
      error_code: "NOTIFICATION_FAILED",
      message: err.message,
      videoId
    });
  }
}

async function main() {
  log("info", { event: "notifier_started" });

  while (true) {
    const notification = await dequeueJobSilent("notification_jobs");
    if (notification) {
      await processNotification(notification);
    }
  }
}

main();
