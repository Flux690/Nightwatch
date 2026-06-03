import { Worker } from "bullmq";
import { bullmqConnection } from "../redis/client.js";
import { runInvestigation } from "../investigation/loop.js";
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
    console.log(`[worker] job ${job.id} completed`);
  });

  worker.on("failed", (job, err) => {
    console.error(`[worker] job ${job?.id} failed:`, err.message);
  });

  return worker;
}
