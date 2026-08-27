import { DOCKER_TOOLS } from "./tools/docker.js";
import { GITHUB_TOOLS } from "./tools/github.js";
import { HOST_TOOLS } from "./tools/host.js";
import { K8S_TOOLS } from "./tools/kubernetes.js";
import { LOKI_TOOLS } from "./tools/loki.js";
import { METRICS_TOOLS } from "./tools/metrics.js";
import { REPO_TOOLS } from "./tools/repo.js";
import type { Tool } from "./tools/types.js";
import type { EvidenceKind } from "@nightwarden/shared";

// The tools that question the system under investigation, grouped by what each
// one questions: two Docker reads ask one daemon, a metric and a log ask two.
const EVIDENCE_SOURCES: ReadonlyArray<readonly [string, Tool[]]> = [
  ["docker", DOCKER_TOOLS],
  ["host", HOST_TOOLS],
  ["kubernetes", K8S_TOOLS],
  ["repo", REPO_TOOLS],
  ["github", GITHUB_TOOLS],
  ["metrics", METRICS_TOOLS],
  ["loki", LOKI_TOOLS],
];

const BY_TOOL = new Map(
  EVIDENCE_SOURCES.flatMap(([source, tools]) =>
    tools.map((tool): [string, string] => [tool.schema.name, source]),
  ),
);

/* Whether a claim may rest on this call, and so whether it is issued an evidence
   id at all. Recording a claim, writing the report and asking a person are none
   of them observations of the system, so none of them can back one. */
export function isCitable(toolName: string): boolean {
  return BY_TOOL.has(toolName);
}

// A name in no group stands alone rather than joining a catch-all one, so it
// can never corroborate a second call to itself.
export function evidenceSource(toolName: string): string {
  return BY_TOOL.get(toolName) ?? toolName;
}

const KIND_BY_TOOL = new Map(
  EVIDENCE_SOURCES.flatMap(([, tools]) =>
    tools.map((tool): [string, EvidenceKind] => [
      tool.schema.name,
      tool.evidenceKind,
    ]),
  ),
);

// From the tool's own declaration. A name no group knows reads as plain text:
// the result is still quotable, just not typed.
export function evidenceKind(toolName: string): EvidenceKind {
  return KIND_BY_TOOL.get(toolName) ?? "text";
}
