import {
  composeServiceLabels,
  parseTargetKey,
  type DockerFleetRunner,
  type DockerServiceIdentity,
  type FleetRunner,
  type K8sWorkloadKind,
  type KubernetesFleetRunner,
  type KubernetesWorkloadIdentity,
} from "@nightwarden/shared";

// Resolved names every key to act on - one per server running the service that
// matched - and unresolved the raw labels that formatAlert renders in full.
type AlertResolution =
  { kind: "resolved"; keys: string[] } | { kind: "unresolved" };

// Walks what the fleet advertises and asks whether these labels describe it.
// The other direction mints keys nothing advertises, each needing an answer.
export function resolveAlertTarget(
  labels: Record<string, string>,
  fleet: FleetRunner[],
): AlertResolution {
  // Partitioned by platform, so no matcher has to ask what it was handed. The
  // labels reach both, which is why each keeps its own precondition.
  const keys: string[] = [];
  for (const runner of fleet) {
    keys.push(
      ...(runner.platform === "docker"
        ? dockerMatches(labels, runner)
        : kubernetesMatches(labels, runner)),
    );
  }

  // Compared without the server segment, so the same service on two machines is
  // one candidate with two addresses rather than two rival candidates.
  const services = new Set(keys.map(serviceOf));
  // More than one distinct service, or none: no candidate outranks another, so we
  // say nothing rather than pick. The agent has every label and a list tool.
  if (services.size !== 1) return { kind: "unresolved" };

  return { kind: "resolved", keys: [...new Set(keys)] };
}

// The key minus its server, which is what "the same service" means across a fleet.
function serviceOf(key: string): string {
  const parsed = parseTargetKey(key);
  return parsed === null ? key : `${parsed.scope}/${parsed.name}`;
}

function dockerMatches(
  labels: Record<string, string>,
  runner: DockerFleetRunner,
): string[] {
  return runner.services
    .filter((entry) => describesDockerService(labels, entry.identity))
    .map((entry) => entry.target);
}

function kubernetesMatches(
  labels: Record<string, string>,
  runner: KubernetesFleetRunner,
): string[] {
  return runner.services
    .filter((entry) => describesK8sWorkload(labels, entry.identity, entry.kind))
    .map((entry) => entry.target);
}

function describesDockerService(
  labels: Record<string, string>,
  identity: DockerServiceIdentity,
): boolean {
  // `namespace` means Kubernetes, which Docker and Compose alerts never carry.
  // Without it a Kubernetes alert's `container` label matches a Docker host running
  // a container of that name, forcing a perfectly resolvable alert to unresolved.
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

// A pod name carries its owner, but only against a known kind: matching bare
// names would resolve `web-0` to a Deployment named `web`.
function podBelongsToWorkload(
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
