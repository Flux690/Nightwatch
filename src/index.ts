#!/usr/bin/env node

import "dotenv/config";

import { Command } from "commander";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { startMonitoring, LogBatch } from "./observation/logBuffer";
import { runOrchestrator } from "./orchestration/workflow";
import { loadInfrastructure } from "./orchestration/composeLoader";
import { setContext } from "./globals";
import type { NightwatchConfig } from "./config";
import { logger } from "./utils/logger";
import { getErrorMessage } from "./utils/helpers";
import { docker } from "./tools/docker";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(path.join(__dirname, "..", "package.json"), "utf-8"),
);

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

const program = new Command();

program
  .name("nightwatch")
  .description(
    "Autonomous SRE agent that monitors Docker containers and remediates incidents",
  )
  .version(pkg.version)
  .option(
    "--compose <paths>",
    "Comma-separated compose file paths or directory (default: auto-discover in cwd)",
  )
  .option("--mode <mode>", "observe or remediate", "remediate")
  .option(
    "--max-retries <n>",
    "Max replan attempts before escalation",
    "3",
  )
  .addHelpText(
    "after",
    `
Examples:
  nightwatch                                          # auto-discover in cwd
  nightwatch --compose docker-compose.yml             # single file
  nightwatch --compose db.yml,api.yml,cache.yml       # multiple files
  nightwatch --compose ./services/                    # auto-discover in directory`,
  );

program.action(async (opts) => {
  // Validate mode
  if (opts.mode !== "remediate" && opts.mode !== "observe") {
    console.error(
      `Invalid mode: "${opts.mode}". Must be "remediate" or "observe".`,
    );
    process.exit(1);
  }

  // Validate maxRetries
  const maxRetries = parseInt(opts.maxRetries, 10);
  if (isNaN(maxRetries) || maxRetries < 1) {
    console.error(
      `Invalid max-retries: "${opts.maxRetries}". Must be a positive integer.`,
    );
    process.exit(1);
  }

  // Load infrastructure (fail early with clear error)
  const infrastructure = loadInfrastructure(opts.compose);

  // Build config
  const config: NightwatchConfig = {
    mode: opts.mode,
    maxRetries,
  };

  // Set runtime context for all consumers
  setContext(infrastructure, config);

  // Banner
  logger.startup(infrastructure, config);
  console.log();

  // Pre-flight checks
  try {
    await docker.ping();
    console.log("  \x1b[32m\u2713\x1b[0m Docker daemon reachable");
  } catch {
    console.error(
      "\n  \x1b[31m\u2717\x1b[0m Docker daemon not reachable. Is Docker running?",
    );
    process.exit(1);
  }

  try {
    const running = await docker.listContainers({ all: true });
    const runningNames = running.map(
      (c) => c.Names?.[0]?.replace(/^\//, "") ?? "",
    );
    const missing = infrastructure.containers.filter(
      (name) => !runningNames.includes(name),
    );

    if (missing.length > 0) {
      console.error(
        `\n  \x1b[31m\u2717\x1b[0m Missing containers: ${missing.join(", ")}`,
      );
      console.error(
        "    Start them with: docker compose up -d",
      );
      process.exit(1);
    }
    console.log(
      `  \x1b[32m\u2713\x1b[0m All ${infrastructure.containers.length} containers found`,
    );
  } catch (err) {
    console.error(
      `\n  \x1b[31m\u2717\x1b[0m Failed to list containers: ${getErrorMessage(err)}`,
    );
    process.exit(1);
  }

  if (!process.env.GEMINI_API_KEY) {
    console.error(
      "\n  \x1b[31m\u2717\x1b[0m GEMINI_API_KEY environment variable is not set.",
    );
    process.exit(1);
  }
  console.log("  \x1b[32m\u2713\x1b[0m Gemini API key configured");

  // Start monitoring
  logger.listening();

  const stopMonitoring = await startMonitoring(
    infrastructure.containers,
    10000,
    async (batch: LogBatch) => {
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
    },
  );

  // Consolidated signal handlers
  const shutdown = () => {
    stopMonitoring();
    logger.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise(() => {});
});

program.parseAsync().catch((err) => {
  console.error(`Startup failed: ${getErrorMessage(err)}`);
  process.exit(1);
});
