import type { Platform } from "@nightwarden/shared";

// One image per platform: a Docker runner carries no Kubernetes client and a
// Kubernetes runner carries no dockerode, so the binary is the declaration.
const DEFAULT_IMAGE: Record<Platform, string> = {
  docker: "ghcr.io/prabhatmattoo/nightwarden-docker-runner:latest",
  kubernetes: "ghcr.io/prabhatmattoo/nightwarden-kubernetes-runner:latest",
};

// Override either one for a private registry.
const IMAGE_ENV_VAR: Record<Platform, string> = {
  docker: "NIGHTWARDEN_DOCKER_RUNNER_IMAGE",
  kubernetes: "NIGHTWARDEN_KUBERNETES_RUNNER_IMAGE",
};

export function runnerImage(platform: Platform): string {
  return process.env[IMAGE_ENV_VAR[platform]] ?? DEFAULT_IMAGE[platform];
}
