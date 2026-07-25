import type { FastifyInstance } from "fastify";
import { requireSession } from "../auth/session.js";
import { extractBearerToken } from "../auth/bearer.js";
import { findRunnerByToken } from "../db/runner.js";
import { publicWsUrl } from "../config/public-url.js";
import { RUNNER_IMAGE } from "./image.js";

const TEMPLATE = `\
apiVersion: v1
kind: Namespace
metadata:
  name: nightwarden
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: nightwarden-runner
  namespace: nightwarden
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: nightwarden-runner-read
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
  name: nightwarden-runner-write
rules:
  - apiGroups: ["apps"]
    resources: ["deployments", "statefulsets"]
    verbs: ["patch"]
  - apiGroups: [""]
    resources: ["pods/exec"]
    verbs: ["create"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: nightwarden-runner-read
subjects:
  - kind: ServiceAccount
    name: nightwarden-runner
    namespace: nightwarden
roleRef:
  kind: ClusterRole
  name: nightwarden-runner-read
  apiGroup: rbac.authorization.k8s.io
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: nightwarden-runner-write
subjects:
  - kind: ServiceAccount
    name: nightwarden-runner
    namespace: nightwarden
roleRef:
  kind: ClusterRole
  name: nightwarden-runner-write
  apiGroup: rbac.authorization.k8s.io
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nightwarden-runner
  namespace: nightwarden
spec:
  replicas: 1
  selector:
    matchLabels:
      app: nightwarden-runner
  template:
    metadata:
      labels:
        app: nightwarden-runner
    spec:
      serviceAccountName: nightwarden-runner
      containers:
        - name: runner
          image: {{RUNNER_IMAGE}}
          env:
            - name: NIGHTWARDEN_TOKEN
              value: "{{NIGHTWARDEN_TOKEN}}"
            - name: WS_URL
              value: "{{WS_URL}}"
            - name: NIGHTWARDEN_SERVER_NAME
              value: "{{NIGHTWARDEN_SERVER_NAME}}"
`;

export function buildManifest(
  wsUrl: string,
  token: string,
  serverName = "",
): string {
  return TEMPLATE.replaceAll("{{RUNNER_IMAGE}}", RUNNER_IMAGE)
    .replaceAll("{{NIGHTWARDEN_TOKEN}}", token)
    .replaceAll("{{WS_URL}}", wsUrl)
    .replaceAll("{{NIGHTWARDEN_SERVER_NAME}}", serverName);
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

      const record = findRunnerByToken(token);
      if (!record) {
        return reply.code(404).send({ error: "token not found" });
      }

      const yaml = buildManifest(
        publicWsUrl(request, "/api/clients/connect"),
        token,
        record.serverName ?? "",
      );

      reply.header("Content-Type", "application/yaml; charset=utf-8");
      return reply.code(200).send(yaml);
    },
  );
}
