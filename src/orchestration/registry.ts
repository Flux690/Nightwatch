import { FunctionDeclaration, Type } from "@google/genai";
import type { NightwatchConfig } from "../config";

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
  consultUser:
    "Consult the user for input. Use for plan approval (type: plan_approval), missing context from feasibility (type: missing_context), or when stuck and needing human help (type: escalation).",
  executePlan:
    "Execute the remediation steps from the validated plan. Use only after the plan has been approved by the user.",
  verifyPlan:
    "Verify that the remediation resolved the incident by running verification commands. Use after execution succeeds.",
  reportFindings:
    "Report diagnostic findings and complete observation. Use in observe mode after analysis and feasibility assessment are complete.",
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
export function getCapabilities(mode: NightwatchConfig["mode"]): FunctionDeclaration[] {
  const baseTools: CapabilityName[] = [
    "analyzeIncident",
    "assessFeasibility",
    "consultUser",
  ];

  const remediationTools: CapabilityName[] = [
    "planRemediation",
    "validatePlan",
    "executePlan",
    "verifyPlan",
  ];

  const observeTools: CapabilityName[] = ["reportFindings"];

  const allowedNames =
    mode === "remediate"
      ? [...baseTools, ...remediationTools]
      : [...baseTools, ...observeTools];

  return allowedNames.map((name) => {
    if (name === "consultUser") {
      return makeTool(name, CAPABILITY_DEFINITIONS[name], {
        type: Type.OBJECT,
        properties: {
          type: {
            type: Type.STRING,
            description: "Type of consultation: plan_approval, missing_context, or escalation",
          },
          reason: {
            type: Type.STRING,
            description: "Why user input is needed. Displayed to the user.",
          },
          question: {
            type: Type.STRING,
            description: "Specific question to ask (for missing_context type).",
          },
        },
        required: ["type", "reason"],
      });
    }
    return makeTool(name, CAPABILITY_DEFINITIONS[name]);
  });
}
