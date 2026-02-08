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

// ANSI colors & icons
const COLORS = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[90m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
  white: "\x1b[97m",
  gray: "\x1b[37m",
} as const;

const ICONS = {
  success: "✓",
  failure: "✗",
  warning: "⚠",
};

type ColorName = keyof typeof COLORS;
const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

// Color helpers
const c = (color: ColorName, text: string): string =>
  COLORS[color] + text + COLORS.reset;

const cb = (color: ColorName, text: string): string =>
  COLORS.bright + COLORS[color] + text + COLORS.reset;

// Time & text helpers
function getTimestamp(): string {
  return new Date().toISOString().split("T")[1].split(".")[0];
}

function ts(): string {
  return c("dim", `[${getTimestamp()}]`);
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

// Track last plan line count for gray-out functionality
let lastPlanLineCount = 0;

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
    const line = `${ts()} ${c("gray", message)}${frames[frame]}`;
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

    console.log(
      `${baseIndent}${c("gray", prefix)} ${c("white", key)}: ${c("gray", wrappedValue)}`,
    );
  });
}

// Logger API
export const logger = {
  startup(containers: string[], mode: string): void {
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

    console.log(cb("white", banner.trim()));
    console.log(c("white", subheading));
    console.log();
    console.log(
      `  ${c("white", "Monitoring")} : ${cb("white", `[ ${containers.map((c) => `'${c}'`).join(", ")} ]`)}`,
    );
    console.log(
      `  ${c("white", "Mode")}       : ${cb("white", mode.charAt(0).toUpperCase() + mode.slice(1))}`,
    );
  },

  listening(): void {
    stopEllipsis();
    console.log();
    startEllipsis("Listening for logs");
  },

  stage(name: string): void {
    stopEllipsis();
    console.log();
    console.log(cb("white", name));
  },

  action(message: string): void {
    stopEllipsis();
    startEllipsis(message);
  },

  tool(name: string, args?: Record<string, unknown>): void {
    stopEllipsis();
    let argsStr = "";
    if (args && name !== "ask_user") {
      try {
        argsStr = ` ${c("dim", JSON.stringify(args))}`;
      } catch {
        argsStr = ` ${c("dim", "[unserializable args]")}`;
      }
    }

    console.log(
      `${ts()} ${c("magenta", "Tool:")} ${c("white", name)}${argsStr}`,
    );
  },

  result(
    success: boolean,
    message: string,
    details?: Record<string, string | number | boolean>,
  ): void {
    stopEllipsis();
    const icon = success ? ICONS.success : ICONS.failure;
    const color: ColorName = success ? "green" : "red";
    const line = `${ts()} ${c(color, icon)} ${c("white", message)}`;

    console.log(line);
    if (details) logIndentedDetails(details);
  },

  warn(message: string, details?: Record<string, string | number | boolean>) {
    stopEllipsis();
    const line = `${ts()} ${c("yellow", ICONS.warning)} ${c("white", message)}`;
    console.log(line);
    if (details) logIndentedDetails(details);
  },

  info(message: string): void {
    stopEllipsis();
    console.log(`${ts()} ${c("gray", message)}`);
  },

  plan(plan: RemediationPlan): void {
    stopEllipsis();
    let lineCount = 0;

    if (!plan.steps.length) {
      logger.result(false, "No safe remediation possible", {
        Summary: plan.summary,
      });
      lastPlanLineCount = 0;
      return;
    }

    console.log(
      `${ts()} ${c("green", ICONS.success)} ${c("white", "Plan generated")}`,
    );
    lineCount++;
    logIndentedDetails({ Summary: plan.summary });
    lineCount++; // Summary line

    const indent = " ".repeat(visibleLength(ts()) + 3);

    console.log(`\n${indent}${c("gray", "Remediation Steps:")}`);
    lineCount += 2; // blank line + header
    plan.steps.forEach((s, i) => {
      console.log(
        `${indent}  ${c("white", `${i + 1}.`)} ${c("white", s.action)}`,
      );
      lineCount++;
      console.log(`${indent}     ${c("dim", s.reason)}`);
      lineCount++;
    });

    if (plan.verification.length > 0) {
      console.log(`\n${indent}${c("gray", "Verification Steps:")}`);
      lineCount += 2; // blank line + header
      plan.verification.forEach((s, i) => {
        console.log(
          `${indent}  ${c("white", `${i + 1}.`)} ${c("white", s.action)}`,
        );
        lineCount++;
        console.log(`${indent}     ${c("dim", s.reason)}`);
        lineCount++;
      });
    }

    lastPlanLineCount = lineCount;
  },

  planGrayOut(plan: RemediationPlan, linesAfterPlan: number = 0): void {
    if (lastPlanLineCount === 0) return;

    const totalLines = lastPlanLineCount + linesAfterPlan;

    // Move cursor up
    process.stdout.write(`\x1b[${totalLines}A`);

    // Rewrite plan in dim (same structure as plan(), but all dim)
    console.log(
      `${ts()} ${c("dim", ICONS.success)} ${c("dim", "Plan generated")}`,
    );

    // Use same wrapping logic as logIndentedDetails for Summary
    const baseIndent = " ".repeat(visibleLength(ts()) + 3);
    const labelPrefix = `${baseIndent}└─ Summary: `;
    const continuationIndent = " ".repeat(visibleLength(labelPrefix));
    const wrappedSummary = wrapText(plan.summary, labelPrefix, continuationIndent);
    console.log(`${baseIndent}${c("dim", "└─")} ${c("dim", "Summary")}: ${c("dim", wrappedSummary)}`);

    const indent = " ".repeat(visibleLength(ts()) + 3);

    console.log(`\n${indent}${c("dim", "Remediation Steps:")}`);
    plan.steps.forEach((s, i) => {
      console.log(
        `${indent}  ${c("dim", `${i + 1}.`)} ${c("dim", s.action)}`,
      );
      console.log(`${indent}     ${c("dim", s.reason)}`);
    });

    if (plan.verification.length > 0) {
      console.log(`\n${indent}${c("dim", "Verification Steps:")}`);
      plan.verification.forEach((s, i) => {
        console.log(
          `${indent}  ${c("dim", `${i + 1}.`)} ${c("dim", s.action)}`,
        );
        console.log(`${indent}     ${c("dim", s.reason)}`);
      });
    }

    // Clear the lines that were after the plan
    const termWidth = process.stdout.columns || 120;
    for (let i = 0; i < linesAfterPlan; i++) {
      console.log(" ".repeat(termWidth));
    }
    if (linesAfterPlan > 0) {
      process.stdout.write(`\x1b[${linesAfterPlan}A`);
    }

    lastPlanLineCount = 0;
  },

  trace(items: StepResult[]): void {
    stopEllipsis();
    const indent = " ".repeat(visibleLength(ts()) + 3);

    items.forEach((item, i) => {
      const icon = item.status === "success" ? ICONS.success : ICONS.failure;
      const color: ColorName = item.status === "success" ? "green" : "red";

      console.log(
        `${ts()} ${c(color, icon)} ${c("white", `Step ${i + 1}:`)} ${c("gray", item.step)}`,
      );

      const output = (item.stdout || item.stderr || "").trim();
      if (output) {
        output
          .split("\n")
          .forEach((l) => console.log(`${indent}${c("dim", l)}`));
      }
    });
  },

  shutdown(): void {
    stopEllipsis();
    console.log();
    console.log(`${ts()} ${c("gray", "Shutting down Nightwatch")}`);
    process.stdout.write(SHOW_CURSOR);
  },

  approvalRequired(): void {
    stopEllipsis();
    console.log(
      `${ts()} ${c("cyan", "?")} ${cb("white", "Approval Required")}`,
    );
  },

  incidentGraph(graph: IncidentGraph): void {
    stopEllipsis();
    console.log(
      `${ts()} ${c("green", ICONS.success)} ${c("white", "Incident Graph Identified")}`,
    );
    logIndentedDetails({
      Summary: graph.summary,
    });

    const indent = " ".repeat(visibleLength(ts()) + 3);

    // Show affected components with evidence
    console.log(`\n${indent}${c("gray", "Affected Components:")}`);
    graph.nodes.forEach((node, i) => {
      const isRoot = i === graph.root;
      const marker = isRoot ? ` ${c("yellow", "[ROOT]")}` : "";
      console.log(
        `${indent}  ${c("white", `${i}.`)} ${c("white", node.container)}${marker}`,
      );
      console.log(`${indent}     ${c("dim", node.type)}`);
      // Show first evidence line
      if (node.evidence.length > 0) {
        const evidencePreview =
          node.evidence[0].length > 80
            ? node.evidence[0].substring(0, 77) + "..."
            : node.evidence[0];
        console.log(
          `${indent}     ${c("dim", `Evidence: ${evidencePreview}`)}`,
        );
      }
    });

    // Show causal chain if edges exist
    if (graph.edges.length > 0) {
      console.log(`\n${indent}${c("gray", "Causal Chain:")}`);
      graph.edges.forEach((edge) => {
        const fromNode = graph.nodes[edge.from];
        const toNode = graph.nodes[edge.to];
        console.log(
          `${indent}  ${c("white", fromNode?.container || `Node ${edge.from}`)} ${c("dim", "→")} ${c("white", toNode?.container || `Node ${edge.to}`)}`,
        );
      });
    }
  },

  feasibilityQuestion(question: string): void {
    stopEllipsis();
    const iconIndent = " ".repeat(visibleLength(ts()) + 1);
    const textIndent = " ".repeat(visibleLength(ts()) + 3);
    const labelPrefix = `${iconIndent}${c("cyan", "?")} `;
    const wrappedQuestion = wrapText(question, labelPrefix, textIndent);
    console.log(`${iconIndent}${c("cyan", "?")} ${c("white", wrappedQuestion)}`);
    console.log(`${textIndent}${c("dim", "(type 'skip' to continue without answering)")}`);
  },

  feasibility(assessment: FeasibilityAssessment): void {
    if (assessment.feasible) {
      logger.result(true, "Remediation is feasible", {
        Summary: assessment.summary,
      });
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

  escalationPrompt(reason: string, neededContext: string): void {
    stopEllipsis();
    console.log(
      `${ts()} ${c("yellow", ICONS.warning)} ${cb("yellow", "Agent Requesting Help")}`,
    );
    logIndentedDetails({
      Reason: reason,
      "Needed Context": neededContext,
    });
    const indent = " ".repeat(visibleLength(ts()) + 3);
    console.log(
      `${indent}${c("dim", "(provide context to continue, or type 'stop' to dismiss)")}`,
    );
  },

  resolved(type: string, summary: string): void {
    stopEllipsis();
    console.log();
    console.log(
      `${ts()} ${c("green", ICONS.success)} ${cb("green", "Incident Resolved")}`,
    );
    logIndentedDetails({ Incident: type, Resolution: summary });
  },

  dismissed(type: string): void {
    stopEllipsis();
    console.log();
    console.log(
      `${ts()} ${c("yellow", ICONS.warning)} ${cb("yellow", "Incident Dismissed")}`,
    );
    logIndentedDetails({ Incident: type });
  },

  observed(type: string, summary: string): void {
    stopEllipsis();
    console.log();
    console.log(
      `${ts()} ${c("cyan", ICONS.success)} ${cb("cyan", "Observation Complete")}`,
    );
    logIndentedDetails({ Incident: type, Summary: summary });
  },
};
