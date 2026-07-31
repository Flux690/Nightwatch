import { checkLLMReadiness } from "../../config/readiness.js";
import { REPORT_TOOL_SCHEMA } from "../prompts/report.js";
import { enrichReport, saveReport, validateReportInput } from "../report.js";
import type { Tool, ToolExecuteResult } from "./types.js";

// Thin adapter over the report domain service (agent/report.ts). Offered in
// investigate mode only; the toolset gates it out of ask runs.
export const REPORT_TOOLS: Tool[] = [
  {
    schema: REPORT_TOOL_SCHEMA,
    access: "read",
    on: "api",
    execute: async (input, ctx): Promise<ToolExecuteResult> => {
      const report = validateReportInput(input);
      if (report === null) {
        return {
          content:
            "Invalid report shape. Send the COMPLETE report matching the UpdateReport schema.",
          outcome: "system",
        };
      }
      // A run cannot start unconfigured, so the active provider's model is set by
      // the time any tool executes; the fallback only keeps attribution honest.
      const readiness = checkLLMReadiness();
      const model = readiness.ready ? readiness.config.model : "unknown";
      saveReport(
        ctx.sessionId,
        enrichReport(report, ctx.sessionId, model),
        model,
      );
      return { content: "Report updated." };
    },
  },
];
