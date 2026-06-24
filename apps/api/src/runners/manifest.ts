import type { FastifyInstance } from "fastify";
import { requireSession } from "../auth/session.js";
import { extractBearerToken } from "../auth/bearer.js";
import { findTokenByValue } from "../db/tokens.js";

const TEMPLATE = `\
apiVersion: v1
kind: Namespace
metadata:
  name: nightwatch
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: nightwatch-runner
  namespace: nightwatch
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: nightwatch-runner-read
rules:
  - apiGroups: [""]
    resources: ["pods", "nodes", "namespaces", "events"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["pods/log"]
    verbs: ["get"]
  - apiGroups: ["apps"]
    resources: ["deployments", "statefulsets", "daemonsets", "replicasets"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: nightwatch-runner-write
rules:
  - apiGroups: ["apps"]
    resources: ["deployments", "statefulsets"]
    verbs: ["patch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: nightwatch-runner-read
subjects:
  - kind: ServiceAccount
    name: nightwatch-runner
    namespace: nightwatch
roleRef:
  kind: ClusterRole
  name: nightwatch-runner-read
  apiGroup: rbac.authorization.k8s.io
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: nightwatch-runner-write
subjects:
  - kind: ServiceAccount
    name: nightwatch-runner
    namespace: nightwatch
roleRef:
  kind: ClusterRole
  name: nightwatch-runner-write
  apiGroup: rbac.authorization.k8s.io
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nightwatch-runner
  namespace: nightwatch
spec:
  replicas: 1
  selector:
    matchLabels:
      app: nightwatch-runner
  template:
    metadata:
      labels:
        app: nightwatch-runner
    spec:
      serviceAccountName: nightwatch-runner
      containers:
        - name: runner
          image: ghcr.io/nightwatch-ai/runner:latest
          env:
            - name: NIGHTWATCH_TOKEN
              value: "{{NIGHTWATCH_TOKEN}}"
            - name: WS_URL
              value: "{{WS_URL}}"
            # Set to "true" to enable write actions (rollout restarts etc.).
            # Defaults to "false" — the runner is read-only until you opt in.
            # - name: REMEDIATION_ENABLED
            #   value: "false"
`;

function buildWsUrl(origin: string): string {
  const wsProto = origin.startsWith("https://") ? "wss" : "ws";
  return `${wsProto}://${origin.replace(/^https?:\/\//, "")}/clients/connect`;
}

export function buildManifest(wsUrl: string, token: string): string {
  return TEMPLATE.replaceAll("{{NIGHTWATCH_TOKEN}}", token).replaceAll(
    "{{WS_URL}}",
    wsUrl,
  );
}

export async function registerManifestRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.get(
    "/manifest.yaml",
    { preHandler: requireSession },
    async (request, reply) => {
      const token = extractBearerToken(request.headers.authorization);
      if (!token) {
        return reply.code(400).send({
          error: "runner token required in Authorization: Bearer header",
        });
      }

      const record = findTokenByValue(token);
      if (!record) {
        return reply.code(404).send({ error: "token not found" });
      }

      const origin = `${request.protocol}://${request.headers.host ?? "localhost"}`;
      const yaml = buildManifest(buildWsUrl(origin), token);

      reply.header("Content-Type", "application/yaml; charset=utf-8");
      return reply.code(200).send(yaml);
    },
  );
}
