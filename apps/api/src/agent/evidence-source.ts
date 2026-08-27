import { DOCKER_TOOLS } from "./tools/docker.js";
import { GITHUB_TOOLS } from "./tools/github.js";
import { HOST_TOOLS } from "./tools/host.js";
import { K8S_TOOLS } from "./tools/kubernetes.js";
import { LOKI_TOOLS } from "./tools/loki.js";
import { METRICS_TOOLS } from "./tools/metrics.js";
import { REPO_TOOLS } from "./tools/repo.js";
import type { Tool } from "./tools/types.js";
import type { EvidenceKind } from "@nightwarden/shared";

// Two Docker reads question one daemon, while a metric query and a log read
// question two. Corroboration means citing two sources.
const LIBRARIES: ReadonlyArray<readonly [string, Tool[]]> = [
  ["docker", DOCKER_TOOLS],
  ["host", HOST_TOOLS],
  ["kubernetes", K8S_TOOLS],
  ["repo", REPO_TOOLS],
  ["github", GITHUB_TOOLS],
  ["metrics", METRICS_TOOLS],
  ["loki", LOKI_TOOLS],
];

const BY_TOOL = new Map(
  LIBRARIES.flatMap(([source, tools]) =>
    tools.map((tool): [string, string] => [tool.schema.name, source]),
  ),
);

// Whether a call reads the system under investigation. A recording tool and an
// elicitation are neither: they add to the record rather than question anything.
export function observesSystem(toolName: string): boolean {
  return BY_TOOL.has(toolName);
}

// A name in no library stands alone rather than joining a catch-all group, so
// it can never corroborate a second call to itself.
export function evidenceSource(toolName: string): string {
  return BY_TOOL.get(toolName) ?? toolName;
}

const KIND_BY_TOOL = new Map(
  LIBRARIES.flatMap(([, tools]) =>
    tools.map((tool): [string, EvidenceKind] => [
      tool.schema.name,
      tool.evidenceKind,
    ]),
  ),
);

// From the tool's own declaration. A name the libraries no longer know reads
// as plain text: the result is still quotable, just not typed.
export function evidenceKind(toolName: string): EvidenceKind {
  return KIND_BY_TOOL.get(toolName) ?? "text";
}
