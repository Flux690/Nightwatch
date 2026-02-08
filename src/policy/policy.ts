import fs from "fs";
import path from "path";
import policySchema from "./policy.schema.json";
import { validateSchema } from "../utils/validateSchema";

export type Policy = {
  mode: "remediate" | "observe";
  constraints: {
    maxActionsPerIncident: number;
  };
};

const POLICY_PATH = path.resolve(process.cwd(), "policy.json");

function loadPolicy(): Policy {
  if (!fs.existsSync(POLICY_PATH)) {
    throw new Error("policy.json not found at project root");
  }

  const raw = fs.readFileSync(POLICY_PATH, "utf-8");
  const parsed = JSON.parse(raw) as unknown;

  return validateSchema<Policy>(policySchema, parsed, "policy");
}

export const policy = loadPolicy();
