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
        "Put this session under investigation, which makes the report tools available to you and switches the operator's view to the investigation layout. Call this when what you were asked turns out to describe an incident rather than being a request for information. The change is permanent, and there is no tool that undoes it, so do not call it to restart or reset work that has stalled.",
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
