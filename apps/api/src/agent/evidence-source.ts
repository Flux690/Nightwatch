import { DOCKER_TOOLS } from "./tools/docker.js";
import { GITHUB_TOOLS } from "./tools/github.js";
import { HOST_TOOLS } from "./tools/host.js";
import { K8S_TOOLS } from "./tools/kubernetes.js";
import { LOKI_TOOLS } from "./tools/loki.js";
import { PROMETHEUS_TOOLS } from "./tools/prometheus.js";
import { REPO_TOOLS } from "./tools/repo.js";
import type { Tool } from "./tools/types.js";

// Which source a piece of evidence came from, which is the library its tool
// belongs to: two Docker reads question one daemon, while a metric query and a
// log read question two. Corroboration means citing two sources.
const LIBRARIES: ReadonlyArray<readonly [string, Tool[]]> = [
  ["docker", DOCKER_TOOLS],
  ["host", HOST_TOOLS],
  ["kubernetes", K8S_TOOLS],
  ["repo", REPO_TOOLS],
  ["github", GITHUB_TOOLS],
  ["prometheus", PROMETHEUS_TOOLS],
  ["loki", LOKI_TOOLS],
];

const BY_TOOL = new Map(
  LIBRARIES.flatMap(([source, tools]) =>
    tools.map((tool): [string, string] => [tool.schema.name, source]),
  ),
);

// A name in no library stands alone rather than joining a catch-all group, so
// it can never corroborate a second call to itself.
export function evidenceSource(toolName: string): string {
  return BY_TOOL.get(toolName) ?? toolName;
}
