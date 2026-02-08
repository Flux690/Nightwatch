import { FunctionDeclaration, Type } from "@google/genai";
import { Policy } from "../policy/policy";

/**
 * Single source of truth for all capabilities.
 */
const CAPABILITY_DEFINITIONS = {
  analyzeIncident:
    "Analyze error logs to identify the primary infrastructure incident. Use when logs are present but no incident has been identified yet.",
  assessFeasibility:
    "Assess whether a safe remediation plan can be produced for the identified incident. Use after incident is identified, before planning.",
  planRemediation:
    "Generate a remediation plan with Docker commands to resolve the incident. Use after feasibility is confirmed. Also use for replanning after a failed attempt.",
  validatePlan:
    "Validate that all commands in the remediation plan are safe to execute. Use after a plan exists but before execution.",
  requestApproval:
    "Request user approval for the validated remediation plan before execution. Use after validatePlan succeeds and planValidated is true.",
  executePlan:
    "Execute the remediation steps from the validated plan. Use only after the plan has been approved by the user.",
  verifyPlan:
    "Verify that the remediation resolved the incident by running verification commands. Use after execution succeeds.",
  reportFindings:
    "Report diagnostic findings and complete observation. Use in observe mode after analysis and feasibility assessment are complete.",
  escalate:
    "Request human help when stuck. Provide the reason you cannot proceed and what context from the user would help. The user can provide context to continue or dismiss the incident.",
} as const;

export type CapabilityName = keyof typeof CAPABILITY_DEFINITIONS;

const makeTool = (
  name: string,
  description: string,
  parameters?: FunctionDeclaration["parameters"],
): FunctionDeclaration => ({
  name,
  description,
  parameters: parameters ?? { type: Type.OBJECT, properties: {}, required: [] },
});

/**
 * Returns the list of tools available based on the current policy mode.
 */
export function getCapabilities(mode: Policy["mode"]): FunctionDeclaration[] {
  const baseTools: CapabilityName[] = [
    "analyzeIncident",
    "assessFeasibility",
    "escalate",
  ];

  const remediationTools: CapabilityName[] = [
    "planRemediation",
    "validatePlan",
    "requestApproval",
    "executePlan",
    "verifyPlan",
  ];

  const observeTools: CapabilityName[] = ["reportFindings"];

  const allowedNames =
    mode === "remediate"
      ? [...baseTools, ...remediationTools]
      : [...baseTools, ...observeTools];

  return allowedNames.map((name) => {
    if (name === "escalate") {
      return makeTool(name, CAPABILITY_DEFINITIONS[name], {
        type: Type.OBJECT,
        properties: {
          reason: {
            type: Type.STRING,
            description:
              "Why the agent cannot proceed. Be specific about what is blocking progress.",
          },
          needed_context: {
            type: Type.STRING,
            description:
              "What additional information or context from the user might help unblock progress.",
          },
        },
        required: ["reason", "needed_context"],
      });
    }
    return makeTool(name, CAPABILITY_DEFINITIONS[name]);
  });
}
