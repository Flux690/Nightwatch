import { loadConfig } from "../../config/store.js";
import { getSession } from "../../db/sessions.js";
import { REPORT_TOOL_SCHEMA } from "../prompts/report.js";
import {
  buildEvidenceIndex,
  enrichReport,
  saveReport,
  validateReportInput,
} from "../report.js";
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
          is_error: true,
        };
      }
      const index = buildEvidenceIndex(ctx.sessionId);
      const alert = getSession(ctx.sessionId)?.originatingAlert ?? null;
      const model = loadConfig().model;
      saveReport(
        ctx.sessionId,
        enrichReport(report, index, alert, model),
        model,
      );
      return { content: "Report updated." };
    },
  },
];
