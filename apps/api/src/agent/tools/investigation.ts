import { openInvestigation } from "../../db/sessions.js";
import type { Tool, ToolExecuteResult } from "./types.js";

// Not in REPORT_TOOLS: that library is offered only once a session is already
// under investigation, so a session would never be shown the tool that puts it
// under one. The toolset offers this on the inverse condition instead.
export const OPEN_INVESTIGATION_TOOLS: Tool[] = [
  {
    schema: {
      name: "OpenInvestigation",
      description:
        "Put this session under investigation, so that the report tools become available and the console draws the investigation view. Call this when the question you were asked turns out to describe an incident rather than a request for information. The change is permanent and there is no counterpart tool: a session under investigation cannot be returned to a plain conversation.",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: [],
        properties: {},
      },
    },
    // It changes NightWarden's own state, not the fleet's, so it must not gate.
    access: "read",
    // The system prompt is fixed when the provider is created, so the report
    // protocol only joins it on the next run. This tool's description and the
    // report tools' own are what guide the rest of this one.
    on: "api",
    execute: async (_input, ctx): Promise<ToolExecuteResult> => {
      openInvestigation(ctx.sessionId);
      return {
        content:
          "This session is now under investigation. The report tools are available from your next turn onwards.",
      };
    },
  },
];
