import { SERVICE_IDENTITY_SCHEMA } from "./identity-schema.js";
import type { Tool } from "./types.js";

export const REMEDIATION_TOOLS: Tool[] = [
  {
    schema: {
      name: "restart_service",
      description:
        "WRITE: Restart a service. Requires human approval. Causes brief downtime.",
      input_schema: {
        type: "object",
        properties: {
          service: SERVICE_IDENTITY_SCHEMA,
          delaySeconds: {
            type: "number",
            description: "Delay before restart (default 0).",
          },
          rationale: {
            type: "string",
            description: "Why this restart is the correct remediation.",
          },
          risk: {
            type: "string",
            enum: ["low", "medium", "high"],
          },
          estimatedDowntimeSeconds: { type: "number" },
        },
        required: ["service", "rationale", "risk", "estimatedDowntimeSeconds"],
      },
    },
    access: "write",
    on: "runner",
    route: "service",
  },
  {
    schema: {
      name: "exec",
      description:
        "WRITE: Execute a shell command inside the target service's container (docker exec / kubectl exec). Never runs on the host. Requires human approval. Only available when remediation is enabled.",
      input_schema: {
        type: "object",
        properties: {
          service: SERVICE_IDENTITY_SCHEMA,
          command: {
            type: "array",
            items: { type: "string" },
            description: "Command and arguments as an array.",
          },
          reason: { type: "string" },
          risk: { type: "string", enum: ["low", "medium", "high"] },
        },
        required: ["service", "command", "reason", "risk"],
      },
    },
    access: "write",
    on: "runner",
    route: "service",
  },
];
