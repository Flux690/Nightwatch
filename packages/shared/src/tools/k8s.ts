// LLM tool payload types for the Kubernetes-only tools - matched to Anthropic
// TOOL_SCHEMAS in apps/api. These shapes have no Docker equivalent, so they
// are never offered to Docker-only fleets.

import type { ServiceIdentity } from "../service-identity.js";

export interface K8sRolloutStatusInput {
  service: ServiceIdentity;
}

// Node pressure is a node fact, not a per-workload one, so the input is empty
// and the result carries no service identity.
export interface K8sNodeStatusResult {
  nodes: Array<{
    name: string;
    conditions: unknown;
    allocatable: unknown;
    capacity: unknown;
  }>;
}
