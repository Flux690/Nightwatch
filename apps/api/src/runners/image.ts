// One definition for both install paths; override for a private registry.
export const RUNNER_IMAGE =
  process.env["NIGHTWARDEN_RUNNER_IMAGE"] ??
  "ghcr.io/prabhatmattoo/nightwarden-runner:latest";
