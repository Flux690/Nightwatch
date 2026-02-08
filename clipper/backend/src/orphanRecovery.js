import { getOrphanedJobs, updateJobStatus } from "./models/videoModel.js";
import { queueJob } from "./infra/redis.js";
import { log } from "./utils/log.js";

const RECOVERY_INTERVAL_MS = 30000; // Check every 30 seconds

async function recoverOrphanedJobs() {
  try {
    const orphans = await getOrphanedJobs();

    for (const job of orphans) {
      try {
        await queueJob("transcode_jobs", {
          jobId: job.id,
          videoId: job.video_id,
          key: job.original_key,
        });

        // Mark as requeued after successful push to prevent duplicate recovery
        await updateJobStatus(job.id, "requeued");

        log("info", {
          event: "orphan_job_recovered",
          jobId: job.id,
          videoId: job.video_id,
        });
      } catch (err) {
        // Redis still down - will retry next cycle
        log("error", {
          error_code: "ORPHAN_RECOVERY_FAILED",
          message: err.message,
          jobId: job.id,
        });
      }
    }

    if (orphans.length > 0) {
      log("info", {
        event: "orphan_recovery_complete",
        recovered: orphans.length,
      });
    }
  } catch (err) {
    // DB query failed - will retry next cycle
  }
}

export function startOrphanRecovery() {
  log("info", { event: "orphan_recovery_started", intervalMs: RECOVERY_INTERVAL_MS });

  // Run immediately on startup
  recoverOrphanedJobs();

  // Then run periodically
  setInterval(recoverOrphanedJobs, RECOVERY_INTERVAL_MS);
}
