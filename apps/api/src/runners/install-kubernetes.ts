import { runnerImage } from "./image.js";

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
    resources: ["deployments", "statefulsets", "daemonsets"]
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
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: runner
          image: {{RUNNER_IMAGE}}
          # The runner reads its cluster through the API server and writes nothing,
          # so it needs no capability, no escalation and no writable root.
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
          env:
            - name: NIGHTWARDEN_TOKEN
              value: "{{NIGHTWARDEN_TOKEN}}"
            - name: WS_URL
              value: "{{WS_URL}}"
`;

export function kubernetesInstallManifest(
  wsUrl: string,
  token: string,
): string {
  return TEMPLATE.replaceAll("{{RUNNER_IMAGE}}", runnerImage("kubernetes"))
    .replaceAll("{{NIGHTWARDEN_TOKEN}}", token)
    .replaceAll("{{WS_URL}}", wsUrl);
}
