/**
 * Unified logging utility for Nightwatch.
 * UX-preserving, production-hardened version.
 */

import {
  IncidentGraph,
  FeasibilityAssessment,
  RemediationPlan,
  StepResult,
  ExecutionResult,
} from "../types";
import type { Infrastructure } from "../orchestration/composeLoader";
import type { NightwatchConfig } from "../config";
import { pc, brightWhite, lightPurple } from "./colors";

const ICONS = {
  success: "✓",
  failure: "✗",
  warning: "⚠",
};

const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

// Time & text helpers
function getTimestamp(): string {
  return new Date().toISOString().split("T")[1].split(".")[0];
}

function ts(): string {
  return pc.gray(`[${getTimestamp()}]`);
}

function visibleLength(str: string): number {
  return str.replace(ANSI_REGEX, "").length;
}

/**
 * Wraps text to fit terminal width with proper continuation indentation.
 * @param text - The text to wrap
 * @param firstLinePrefix - Prefix for the first line (including indent and label)
 * @param continuationIndent - Indent string for continuation lines
 * @returns Formatted string with newlines
 */
function wrapText(
  text: string,
  firstLinePrefix: string,
  continuationIndent: string,
): string {
  const termWidth = process.stdout.columns || 120;
  const firstLineMax = termWidth - visibleLength(firstLinePrefix);
  const continuationMax = termWidth - visibleLength(continuationIndent);

  // If text fits on first line, return as-is
  if (text.length <= firstLineMax) {
    return text;
  }

  const words = text.split(" ");
  const lines: string[] = [];
  let currentLine = "";
  let isFirstLine = true;

  for (const word of words) {
    const maxWidth = isFirstLine ? firstLineMax : continuationMax;
    const testLine = currentLine ? `${currentLine} ${word}` : word;

    if (testLine.length > maxWidth && currentLine) {
      lines.push(currentLine);
      currentLine = word;
      isFirstLine = false;
    } else {
      currentLine = testLine;
    }
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  // Join lines: first line as-is, continuation lines with indent
  return lines
    .map((line, i) => (i === 0 ? line : `\n${continuationIndent}${line}`))
    .join("");
}

function clearLine(): void {
  process.stdout.write("\r");
  process.stdout.write(" ".repeat(process.stdout.columns || 120));
  process.stdout.write("\r");
}

// Dynamic ellipsis animation
let ellipsisTimer: NodeJS.Timeout | null = null;
let ellipsisActive = false;

// Plan gray-out state — only tracks lines when a plan is active
let activePlan: RemediationPlan | null = null;
let planLineCount = 0;
let linesAfterPlan = 0;

// Invalidate tracking on terminal resize so grayout degrades gracefully
process.stdout.on("resize", () => {
  activePlan = null;
  planLineCount = 0;
  linesAfterPlan = 0;
});

function logLine(...args: Parameters<typeof console.log>): void {
  if (activePlan) {
    let lines = 1;
    for (const arg of args) {
      if (typeof arg === "string") {
        lines += (arg.match(/\n/g) || []).length;
      }
    }
    linesAfterPlan += lines;
  }
  console.log(...args);
}

/**
 * Increment the line counter from outside the logger (e.g. prompt.ts).
 */
export function trackLine(count: number = 1): void {
  if (activePlan) {
    linesAfterPlan += count;
  }
}

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

function startEllipsis(message: string): void {
  if (ellipsisActive) return;
  stopEllipsis();
  ellipsisActive = true;

  process.stdout.write(HIDE_CURSOR);
  const frames = ["   ", ".  ", ".. ", "..."];
  let frame = 0;

  ellipsisTimer = setInterval(() => {
    const line = `${ts()} ${pc.white(message)}${frames[frame]}`;
    process.stdout.write(`\r${line}   `);
    frame = (frame + 1) % frames.length;
  }, 350);
}

function stopEllipsis(): void {
  if (!ellipsisActive) return;

  if (ellipsisTimer) {
    clearInterval(ellipsisTimer);
    ellipsisTimer = null;
  }

  ellipsisActive = false;
  clearLine();
  process.stdout.write(SHOW_CURSOR);
}

// Hierarchical logging
function logIndentedDetails(
  details: Record<string, string | number | boolean>,
): void {
  const baseIndent = " ".repeat(visibleLength(ts()) + 3);

  const keys = Object.keys(details);
  keys.forEach((key, index) => {
    const isLast = index === keys.length - 1;
    const prefix = isLast ? "└─" : "├─";

    // Build the label prefix for measuring
    const labelPrefix = `${baseIndent}${prefix} ${key}: `;
    // Continuation indent aligns with content start (after "Key: ")
    const continuationIndent = " ".repeat(visibleLength(labelPrefix));

    const wrappedValue = wrapText(
      String(details[key]),
      labelPrefix,
      continuationIndent,
    );

    logLine(
      `${baseIndent}${pc.white(prefix)} ${brightWhite(key)}: ${pc.white(wrappedValue)}`,
    );
  });
}

// Logger API
export const logger = {
  startup(infrastructure: Infrastructure, config: NightwatchConfig): void {
    stopEllipsis();

    const banner = `
███╗   ██╗██╗ ██████╗ ██╗  ██╗████████╗██╗    ██╗ █████╗ ████████╗ ██████╗██╗  ██╗
████╗  ██║██║██╔════╝ ██║  ██║╚══██╔══╝██║    ██║██╔══██╗╚══██╔══╝██╔════╝██║  ██║
██╔██╗ ██║██║██║  ███╗███████║   ██║   ██║ █╗ ██║███████║   ██║   ██║     ███████║
██║╚██╗██║██║██║   ██║██╔══██║   ██║   ██║███╗██║██╔══██║   ██║   ██║     ██╔══██║
██║ ╚████║██║╚██████╔╝██║  ██║   ██║   ╚███╔███╔╝██║  ██║   ██║   ╚██████╗██║  ██║
╚═╝  ╚═══╝╚═╝ ╚═════╝ ╚═╝  ╚═╝   ╚═╝    ╚══╝╚══╝ ╚═╝  ╚═╝   ╚═╝    ╚═════╝╚═╝  ╚═╝
`;

    const subheading = "Autonomous SRE Agent";

    console.log(pc.bold(brightWhite(banner.trim())));
    console.log(brightWhite(subheading));
    console.log();
    console.log(
      `  ${brightWhite("Compose")}     : ${pc.bold(brightWhite(infrastructure.composePaths.join(", ")))}`,
    );
    console.log(
      `  ${brightWhite("Containers")}  : ${pc.bold(brightWhite(`[ ${infrastructure.containers.map((ct) => `'${ct}'`).join(", ")} ]`))}`,
    );
    console.log(
      `  ${brightWhite("Mode")}        : ${pc.bold(brightWhite(config.mode.charAt(0).toUpperCase() + config.mode.slice(1)))}`,
    );
    console.log(
      `  ${brightWhite("Max Retries")} : ${pc.bold(brightWhite(String(config.maxRetries)))}`,
    );
  },

  listening(): void {
    stopEllipsis();
    console.log();
    startEllipsis("Listening for logs");
  },

  stage(name: string): void {
    stopEllipsis();
    logLine();
    logLine(pc.bold(brightWhite(name)));
  },

  action(message: string): void {
    stopEllipsis();
    startEllipsis(message);
  },

  tool(name: string, args?: Record<string, unknown>): void {
    stopEllipsis();
    let argsStr = "";
    if (args) {
      try {
        argsStr = ` ${pc.gray(JSON.stringify(args))}`;
      } catch {
        argsStr = ` ${pc.gray("[unserializable args]")}`;
      }
    }

    logLine(
      `${ts()} ${lightPurple("Tool:")} ${brightWhite(name)}${argsStr}`,
    );
  },

  result(
    success: boolean,
    message: string,
    details?: Record<string, string | number | boolean>,
  ): void {
    stopEllipsis();
    const icon = success ? ICONS.success : ICONS.failure;
    const colorFn = success ? pc.green : pc.red;
    const line = `${ts()} ${colorFn(icon)} ${brightWhite(message)}`;

    logLine(line);
    if (details) logIndentedDetails(details);
  },

  warn(message: string, details?: Record<string, string | number | boolean>) {
    stopEllipsis();
    const line = `${ts()} ${pc.yellow(ICONS.warning)} ${brightWhite(message)}`;
    logLine(line);
    if (details) logIndentedDetails(details);
  },

  info(message: string): void {
    stopEllipsis();
    logLine(`${ts()} ${pc.white(message)}`);
  },

  plan(plan: RemediationPlan): void {
    stopEllipsis();

    if (!plan.steps.length) {
      logger.result(false, "No safe remediation possible", {
        Summary: plan.summary,
      });
      activePlan = null;
      return;
    }

    // Count lines as we print (before activePlan is set, so logLine doesn't double-count)
    let lines = 0;

    const countLog = (...args: Parameters<typeof console.log>): void => {
      let l = 1;
      for (const arg of args) {
        if (typeof arg === "string") {
          l += (arg.match(/\n/g) || []).length;
        }
      }
      lines += l;
      console.log(...args);
    };

    countLog(
      `${ts()} ${pc.green(ICONS.success)} ${brightWhite("Plan generated")}`,
    );

    // Summary with wrapping (same as logIndentedDetails but counted)
    const baseIndent = " ".repeat(visibleLength(ts()) + 3);
    const labelPrefix = `${baseIndent}└─ Summary: `;
    const contIndent = " ".repeat(visibleLength(labelPrefix));
    const wrappedSummary = wrapText(plan.summary, labelPrefix, contIndent);
    countLog(
      `${baseIndent}${pc.white("└─")} ${brightWhite("Summary")}: ${pc.white(wrappedSummary)}`,
    );

    const indent = " ".repeat(visibleLength(ts()) + 3);

    countLog(`\n${indent}${pc.white("Remediation Steps:")}`);
    plan.steps.forEach((s, i) => {
      countLog(
        `${indent}  ${brightWhite(`${i + 1}.`)} ${brightWhite(s.action.join(" "))}`,
      );
      countLog(`${indent}     ${pc.gray(s.reason)}`);
    });

    if (plan.verification.length > 0) {
      countLog(`\n${indent}${pc.white("Verification Steps:")}`);
      plan.verification.forEach((s, i) => {
        countLog(
          `${indent}  ${brightWhite(`${i + 1}.`)} ${brightWhite(s.action.join(" "))}`,
        );
        countLog(`${indent}     ${pc.gray(s.reason)}`);
      });
    }

    // Activate tracking for lines printed after the plan
    activePlan = plan;
    planLineCount = lines;
    linesAfterPlan = 0;
  },

  planGrayOut(): void {
    if (!activePlan) return;

    const plan = activePlan;
    const totalLines = planLineCount + linesAfterPlan;

    // Move cursor up and clear all lines first
    process.stdout.write(`\x1b[${totalLines}A`);
    for (let i = 0; i < totalLines; i++) {
      process.stdout.write(`\x1b[2K\n`);
    }
    process.stdout.write(`\x1b[${totalLines}A`);

    // Rewrite plan — entire lines wrapped in pc.gray() for uniform color
    const indent = " ".repeat(visibleLength(ts()) + 3);

    console.log(pc.gray(`[${getTimestamp()}] ${ICONS.success} Plan generated`));

    const labelPrefix = `${indent}└─ Summary: `;
    const contIndent = " ".repeat(labelPrefix.length);
    const wrappedSummary = wrapText(plan.summary, labelPrefix, contIndent);
    console.log(pc.gray(`${indent}└─ Summary: ${wrappedSummary}`));

    console.log(pc.gray(`\n${indent}Remediation Steps:`));
    plan.steps.forEach((s, i) => {
      console.log(pc.gray(`${indent}  ${i + 1}. ${s.action.join(" ")}`));
      console.log(pc.gray(`${indent}     ${s.reason}`));
    });

    if (plan.verification.length > 0) {
      console.log(pc.gray(`\n${indent}Verification Steps:`));
      plan.verification.forEach((s, i) => {
        console.log(pc.gray(`${indent}  ${i + 1}. ${s.action.join(" ")}`));
        console.log(pc.gray(`${indent}     ${s.reason}`));
      });
    }

    activePlan = null;
    planLineCount = 0;
    linesAfterPlan = 0;
  },

  trace(items: StepResult[]): void {
    stopEllipsis();
    const indent = " ".repeat(visibleLength(ts()) + 3);

    items.forEach((item, i) => {
      const icon = item.status === "success" ? ICONS.success : ICONS.failure;
      const colorFn = item.status === "success" ? pc.green : pc.red;

      logLine(
        `${ts()} ${colorFn(icon)} ${brightWhite(`Step ${i + 1}:`)} ${pc.white(item.step)}`,
      );

      const output = (item.stdout || item.stderr || "").trim();
      if (output) {
        output
          .split("\n")
          .forEach((l) => logLine(`${indent}${pc.gray(l)}`));
      }
    });
  },

  shutdown(): void {
    stopEllipsis();
    console.log();
    console.log(`${ts()} ${pc.white("Shutting down Nightwatch")}`);
    process.stdout.write(SHOW_CURSOR);
  },

  consultPrompt(reason: string, question?: string): void {
    stopEllipsis();
    const prefix = `${ts()} ${pc.cyan("?")} `;
    const contIndent = " ".repeat(visibleLength(prefix));
    logLine(`${prefix}${brightWhite(wrapText(reason, prefix, contIndent))}`);
    if (question) {
      const indent = " ".repeat(visibleLength(ts()) + 3);
      logLine(`${indent}${pc.gray(wrapText(question, indent, indent))}`);
    }
  },

  incidentGraph(graph: IncidentGraph): void {
    stopEllipsis();
    logLine(
      `${ts()} ${pc.green(ICONS.success)} ${brightWhite("Incident Graph Identified")}`,
    );
    logIndentedDetails({
      Summary: graph.summary,
    });

    const indent = " ".repeat(visibleLength(ts()) + 3);

    // Show affected components with evidence
    logLine(`\n${indent}${pc.white("Affected Components:")}`);
    graph.nodes.forEach((node, i) => {
      const isRoot = i === graph.root;
      const marker = isRoot ? ` ${pc.yellow("[ROOT]")}` : "";
      logLine(
        `${indent}  ${brightWhite(`${i}.`)} ${brightWhite(node.container)}${marker}`,
      );
      logLine(`${indent}     ${pc.gray(node.type)}`);
      // Show first evidence line
      if (node.evidence.length > 0) {
        const evidencePreview =
          node.evidence[0].length > 80
            ? node.evidence[0].substring(0, 77) + "..."
            : node.evidence[0];
        logLine(
          `${indent}     ${pc.gray(`Evidence: ${evidencePreview}`)}`,
        );
      }
    });

    // Show causal chain if edges exist
    if (graph.edges.length > 0) {
      logLine(`\n${indent}${pc.white("Causal Chain:")}`);
      graph.edges.forEach((edge) => {
        const fromNode = graph.nodes[edge.from];
        const toNode = graph.nodes[edge.to];
        logLine(
          `${indent}  ${brightWhite(fromNode?.container || `Node ${edge.from}`)} ${pc.gray("→")} ${brightWhite(toNode?.container || `Node ${edge.to}`)}`,
        );
      });
    }
  },

  feasibility(assessment: FeasibilityAssessment): void {
    if (assessment.feasible) {
      logger.result(true, "Remediation is feasible", {
        Summary: assessment.summary,
      });
    } else if (assessment.missing_context.length > 0) {
      logger.result(false, "Missing information for feasibility");
    } else {
      logger.warn("Remediation not feasible", {
        Reason: assessment.blocking_reason ?? assessment.summary,
      });
    }
  },

  execution(result: ExecutionResult): void {
    logger.trace(result.results);

    if (result.failedAtStep === -1) {
      logger.result(true, "Execution complete");
    } else {
      logger.result(false, "Execution failed", {
        "Failed At Step": result.failedAtStep + 1,
      });
    }
  },

  verification(result: ExecutionResult): void {
    logger.trace(result.results);

    if (result.failedAtStep === -1) {
      logger.result(true, "Verification passed");
    } else {
      logger.result(false, "Verification failed", {
        "Failed At Step": result.failedAtStep + 1,
      });
    }
  },

  resolved(type: string, summary: string): void {
    stopEllipsis();
    console.log();
    console.log(
      `${ts()} ${pc.green(ICONS.success)} ${pc.bold(pc.green("Incident Resolved"))}`,
    );
    logIndentedDetails({ Incident: type, Resolution: summary });
  },

  dismissed(type: string): void {
    stopEllipsis();
    console.log();
    console.log(
      `${ts()} ${pc.yellow(ICONS.warning)} ${pc.bold(pc.yellow("Incident Dismissed"))}`,
    );
    logIndentedDetails({ Incident: type });
  },

  observed(type: string, summary: string): void {
    stopEllipsis();
    console.log();
    console.log(
      `${ts()} ${pc.cyan(ICONS.success)} ${pc.bold(pc.cyan("Observation Complete"))}`,
    );
    logIndentedDetails({ Incident: type, Summary: summary });
  },
};
