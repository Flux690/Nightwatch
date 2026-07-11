// Accepts both Docker and Kubernetes service identities. Echo the identity exactly as
// given in the alert or a prior ListServices result - do not guess.
export const SERVICE_IDENTITY_SCHEMA = {
  oneOf: [
    {
      type: "object",
      properties: {
        provider: { type: "string", enum: ["docker"] },
        project: {
          type: "string",
          description:
            "Compose project name (or the container's own name if it has no Compose labels).",
        },
        service: {
          type: "string",
          description:
            "Compose service name (or the container's own name if it has no Compose labels).",
        },
      },
      required: ["provider", "project", "service"],
    },
    {
      type: "object",
      properties: {
        provider: { type: "string", enum: ["kubernetes"] },
        namespace: {
          type: "string",
          description: "Kubernetes namespace the workload runs in.",
        },
        workload: {
          type: "string",
          description:
            "Deployment or StatefulSet name (the durable workload identifier, not the pod name).",
        },
        container: {
          type: "string",
          description:
            "Optional: the specific container to target in a multi-container pod (e.g. the app container alongside a sidecar). Required only when the pod has more than one container; a tool call against such a pod without it returns the list of choices.",
        },
      },
      required: ["provider", "namespace", "workload"],
    },
  ],
} as const;
