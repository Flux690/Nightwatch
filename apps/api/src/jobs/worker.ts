import { Worker } from "bullmq";
import { bullmqConnection } from "../redis/client.js";
import { runInvestigation } from "../investigation/loop.js";
import { logger } from "../logger.js";
import type { NormalizedAlert } from "@nightwatch/shared";

export function startWorker(): Worker {
  const worker = new Worker(
    "investigations",
    async (job) => {
      const alert = job.data as NormalizedAlert;
      await runInvestigation(alert);
    },
    {
      connection: bullmqConnection,
      concurrency: 5,
    },
  );

  worker.on("completed", (job) => {
    logger.info({ jobId: job.id }, "investigation job completed");
  });

  // err carries the full stack; for OpenAI/Anthropic SDK failures the provider
  // has already logged status/code, so this is the job-level backstop.
  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "investigation job failed");
  });

  return worker;
}
