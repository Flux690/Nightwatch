import {
  composeServiceLabels,
  type DockerFleetRunner,
  type DockerServiceIdentity,
  type FleetRunner,
  type K8sWorkloadKind,
  type KubernetesFleetRunner,
  type KubernetesWorkloadIdentity,
} from "@nightwarden/shared";

// The outcome of matching an alert's labels against the live fleet. Resolved names the key to
// act on; ambiguous names the runners to disambiguate between; unresolved hands the agent the
// raw labels, which formatAlert renders in full alongside the fleet summary.
export type AlertResolution =
  | {
      kind: "resolved";
      identity: DockerServiceIdentity | KubernetesWorkloadIdentity;
      key: string;
    }
  | { kind: "ambiguous"; key: string; runners: string[] }
  | { kind: "unresolved" };

interface Match {
  key: string;
  identity: DockerServiceIdentity | KubernetesWorkloadIdentity;
  runner: string;
}

// Walks what the fleet actually advertises and asks, per entry, whether these labels describe it.
// The other direction - minting every identity the labels could name, then filtering - invents keys
// nothing advertises, and each phantom then has to be reasoned about.
export function resolveAlertTarget(
  labels: Record<string, string>,
  fleet: FleetRunner[],
): AlertResolution {
  // Partitioned by platform, so each matcher only ever sees identities of its own
  // kind and neither has to ask what it was handed. The labels are still offered to
  // both, which is why each matcher keeps its own precondition on them.
  const matches: Match[] = [];
  for (const runner of fleet) {
    matches.push(
      ...(runner.platform === "docker"
        ? dockerMatches(labels, runner)
        : kubernetesMatches(labels, runner)),
    );
  }

  const keys = new Set(matches.map((m) => m.key));
  // More than one distinct service, or none: no candidate outranks another, so we
  // say nothing rather than pick. The agent has every label and a list tool.
  if (keys.size !== 1) return { kind: "unresolved" };

  const first = matches[0]!;
  const runners = [...new Set(matches.map((m) => m.runner))];
  if (runners.length > 1) {
    return { kind: "ambiguous", key: first.key, runners };
  }
  return { kind: "resolved", identity: first.identity, key: first.key };
}

function runnerName(runner: FleetRunner): string {
  return runner.serverName ?? runner.hostname;
}

function dockerMatches(
  labels: Record<string, string>,
  runner: DockerFleetRunner,
): Match[] {
  return runner.services
    .filter((entry) => describesDockerService(labels, entry.identity))
    .map((entry) => ({
      key: entry.target,
      identity: entry.identity,
      runner: runnerName(runner),
    }));
}

function kubernetesMatches(
  labels: Record<string, string>,
  runner: KubernetesFleetRunner,
): Match[] {
  return runner.services
    .filter((entry) => describesK8sWorkload(labels, entry.identity, entry.kind))
    .map((entry) => ({
      key: entry.target,
      identity: entry.identity,
      runner: runnerName(runner),
    }));
}

function describesDockerService(
  labels: Record<string, string>,
  identity: DockerServiceIdentity,
): boolean {
  // An alert carries no platform, only labels that imply one, and a mixed fleet
  // offers every alert to both matchers. `namespace` means Kubernetes, which Docker
  // and Compose alerts never carry: without this, a Kubernetes alert's `container`
  // label matches a Docker host running a container of that name, and the second
  // key forces a perfectly resolvable alert to unresolved.
  if (labels["namespace"] !== undefined) return false;

  // Compose labels are re-stamped on every recreate, so when present they are the
  // authority; a non-match here is a no, never a reason to fall through to a name.
  const compose = composeServiceLabels(labels);
  if (compose !== null) {
    return (
      compose.project === identity.project &&
      compose.service === identity.service
    );
  }

  // No Compose labels: the only thing left is the live container name, which is
  // exactly the shape an anonymous `docker run` container is advertised under.
  const liveName = labels["name"] ?? labels["container"];
  return (
    liveName !== undefined &&
    liveName !== "" &&
    liveName === identity.project &&
    liveName === identity.service
  );
}

// Which label named the workload also names its kind, so a `statefulset` label can
// never match a Deployment that happens to share the name.
const WORKLOAD_LABELS: Array<[string, K8sWorkloadKind]> = [
  ["deployment", "Deployment"],
  ["statefulset", "StatefulSet"],
  ["daemonset", "DaemonSet"],
];

function describesK8sWorkload(
  labels: Record<string, string>,
  identity: KubernetesWorkloadIdentity,
  kind: K8sWorkloadKind,
): boolean {
  if (labels["namespace"] !== identity.namespace) return false;

  for (const [label, labelKind] of WORKLOAD_LABELS) {
    const named = labels[label];
    if (named === undefined) continue;
    if (kind !== labelKind) return false;
    return named === identity.workload;
  }

  // Only a pod name: recoverable from its shape, every rule below being a
  // statement about the kind the entry already declares.
  const pod = labels["pod"];
  if (pod === undefined) return false;
  return podBelongsToWorkload(pod, identity.workload, kind);
}

// rand.String(5) in k8s.io/apimachinery/pkg/util/rand: the random suffix every
// generated pod name ends with.
const POD_SUFFIX_ALPHABET = "bcdfghjklmnpqrstvwxz2456789";
// A ReplicaSet's pod-template-hash is rand.SafeEncodeString(fmt.Sprint(fnv32a.Sum32())),
// which maps each BYTE of a decimal string through alphanums[b % 27]. The input bytes are
// only ever '0'-'9', so the output is only ever these ten characters.
const TEMPLATE_HASH_ALPHABET = "456789bcdf";

function allFrom(text: string, alphabet: string): boolean {
  for (const char of text) {
    if (!alphabet.includes(char)) return false;
  }
  return text.length > 0;
}

// Kubernetes generates pod names from the owning object, so the owner is recoverable from the
// name's shape - but only against a known kind. Matching bare names would resolve pod `web-0` to
// a Deployment named `web`, and a Job's pod `backup-x9k2m` to a Deployment named `backup`.
export function podBelongsToWorkload(
  podName: string,
  workload: string,
  kind: K8sWorkloadKind,
): boolean {
  const prefix = `${workload}-`;
  if (!podName.startsWith(prefix)) return false;
  const remainder = podName.slice(prefix.length);

  if (kind === "StatefulSet") return /^\d+$/.test(remainder);
  if (kind === "DaemonSet") {
    return remainder.length === 5 && allFrom(remainder, POD_SUFFIX_ALPHABET);
  }

  // Deployment: <pod-template-hash>-<5 random>. The narrow hash alphabet closes the
  // CronJob case: `backup-<unix-minutes>-<5 random>` fits this shape structurally, but
  // a unix-minute timestamp begins with `2`, which is not a template-hash character.
  const split = remainder.lastIndexOf("-");
  if (split <= 0) return false;
  const hash = remainder.slice(0, split);
  const suffix = remainder.slice(split + 1);
  return (
    hash.length <= 10 &&
    allFrom(hash, TEMPLATE_HASH_ALPHABET) &&
    suffix.length === 5 &&
    allFrom(suffix, POD_SUFFIX_ALPHABET)
  );
}
