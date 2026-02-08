/**
 * Nightwatch Entry Point
 */

import { startMonitoring, LogBatch } from "./observation/logBuffer";
import { runOrchestrator } from "./orchestration/workflow";
import { infrastructure } from "./infrastructure/compose";
import { logger } from "./utils/logger";
import { policy } from "./policy/policy";
import { getErrorMessage } from "./utils/helpers";

/**
 * Get the root incident type from the incident graph.
 */
function getRootIncidentType(state: {
  incidentGraph: { nodes: { type: string }[]; root: number | null } | null;
}): string {
  if (!state.incidentGraph || state.incidentGraph.root === null)
    return "Unknown";
  const rootNode = state.incidentGraph.nodes[state.incidentGraph.root];
  return rootNode?.type ?? "Unknown";
}

async function main(): Promise<void> {
  const containers = infrastructure.containers;

  logger.startup(containers, policy.mode);
  logger.listening();

  await startMonitoring(containers, 10000, async (batch: LogBatch) => {
    logger.info(
      `New activity detected (${batch.logs.length} logs). Sources: [${batch.containers.join(", ")}]`,
    );
    try {
      const { state: finalState, idle } = await runOrchestrator(batch.logs);

      if (idle) {
        logger.listening();
      } else if (finalState.resolution === "resolved") {
        logger.resolved(
          getRootIncidentType(finalState),
          finalState.plan?.summary ?? "No summary",
        );
        logger.listening();
      } else if (finalState.resolution === "dismissed") {
        logger.dismissed(getRootIncidentType(finalState));
        logger.listening();
      } else if (finalState.resolution === "observed") {
        logger.observed(
          getRootIncidentType(finalState),
          finalState.feasibility?.summary ??
            finalState.incidentGraph?.summary ??
            "No findings",
        );
        logger.listening();
      }
    } catch (err) {
      logger.result(false, "Orchestration failed", {
        Error: getErrorMessage(err),
      });
      logger.listening();
    }
  });

  // Consolidated signal handlers
  const shutdown = () => {
    logger.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise(() => {});
}

main().catch((err) => {
  logger.result(false, "Startup failed", { Error: getErrorMessage(err) });
  process.exit(1);
});
