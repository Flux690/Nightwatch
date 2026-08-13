import type {
  DockerServiceIdentity,
  K8sWorkloadKind,
  KubernetesWorkloadIdentity,
} from "./service-identity.js";

// What a runner is, decided at onboarding and stored on its row. A runner serves
// exactly one of these; it is never probed, and never negotiated at runtime.
export type Platform = "docker" | "kubernetes";

export const PLATFORMS: readonly Platform[] = ["docker", "kubernetes"];

export function isPlatform(value: unknown): value is Platform {
  return typeof value === "string" && PLATFORMS.some((p) => p === value);
}

// Every entry carries its own target key, built by the runner that owns it. Consumers
// that only need the address read this string and never touch identity shape.
interface ServiceEntryBase {
  target: string;
  status: string;
}

export interface DockerServiceEntry extends ServiceEntryBase {
  identity: DockerServiceIdentity;
}

export interface KubernetesWorkloadEntry extends ServiceEntryBase {
  identity: KubernetesWorkloadIdentity;
  // Required, unlike the Docker entry, which has no such notion: the pod-name shape
  // rules that resolve an alert are meaningless without it.
  kind: K8sWorkloadKind;
}

interface RunnerManifestBase {
  hostname: string;
  runnerVersion: string;
}

// platform is the discriminant AND the mismatch check: the API compares it against
// the row, so a Docker install pasted into a cluster is refused rather than half-working.
export interface DockerManifest extends RunnerManifestBase {
  platform: "docker";
  services: DockerServiceEntry[];
}

export interface KubernetesManifest extends RunnerManifestBase {
  platform: "kubernetes";
  services: KubernetesWorkloadEntry[];
}

export type RunnerManifest = DockerManifest | KubernetesManifest;

export interface RunnerRecord {
  id: string;
  token: string;
  platform: Platform;
  serverName: string | null;
  hostname: string | null;
  createdAt: string;
  online: boolean;
  lastSeen: string | null;
  manifest: RunnerManifest | null;
}

// Live view of one connected runner for fleet reasoning: enough to match an alert or
// target identity. Unlike RunnerRecord it has no DB-only fields, and the platform
// discriminant is what lets a caller partition the fleet before matching.
interface FleetRunnerBase {
  runnerId: string;
  // The model-visible address: user-assigned server name, or the
  // self-reported hostname for tokens minted without one.
  serverName: string | null;
  hostname: string;
  online: boolean;
  lastSeen: number;
}

export interface DockerFleetRunner extends FleetRunnerBase {
  platform: "docker";
  services: DockerServiceEntry[];
}

export interface KubernetesFleetRunner extends FleetRunnerBase {
  platform: "kubernetes";
  services: KubernetesWorkloadEntry[];
}

export type FleetRunner = DockerFleetRunner | KubernetesFleetRunner;
