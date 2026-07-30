import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { useTempDb } from "./temp-db.js";
import { mintTestSession } from "./session-helper.js";
import { generateRunnerToken } from "../db/runner.js";
import { registerInstallRoutes } from "../runners/install.js";
import { kubernetesInstallManifest } from "../runners/install-kubernetes.js";
import { mountApi } from "./api-server.js";

const URL = "/api/runners/install";

describe("GET /runners/install", () => {
  let server: FastifyInstance;
  let cleanupDb: () => void;
  let SESSION: string;
  let DOCKER_TOKEN: string;
  let K8S_TOKEN: string;

  beforeAll(async () => {
    cleanupDb = useTempDb();
    SESSION = await mintTestSession();
    DOCKER_TOKEN = generateRunnerToken("docker", "test-server").plaintext;
    K8S_TOKEN = generateRunnerToken("kubernetes", "k8s-server").plaintext;
    server = Fastify({ logger: false, trustProxy: true });
    await mountApi(server, registerInstallRoutes);
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    cleanupDb();
  });

  function get(token: string | null, headers: Record<string, string> = {}) {
    return server.inject({
      method: "GET",
      url: URL,
      headers: {
        cookie: `nw_auth=${SESSION}`,
        ...(token !== null && { authorization: `Bearer ${token}` }),
        ...headers,
      },
    });
  }

  describe("authentication", () => {
    it("returns 401 without a session cookie", async () => {
      const res = await server.inject({
        method: "GET",
        url: URL,
        headers: { authorization: `Bearer ${DOCKER_TOKEN}` },
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 400 when the Authorization header is missing", async () => {
      const res = await get(null);
      expect(res.statusCode).toBe(400);
    });

    it("does not accept the token as a query parameter", async () => {
      const res = await server.inject({
        method: "GET",
        url: `${URL}?token=${DOCKER_TOKEN}`,
        headers: { cookie: `nw_auth=${SESSION}` },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 404 for a token not in the DB", async () => {
      const res = await get("nwr_notarealtoken_just_a_fake_value_xxxx");
      expect(res.statusCode).toBe(404);
    });
  });

  // The point of one endpoint: the artifact is chosen by the row the token names,
  // so an operator cannot fetch the Docker script for a Kubernetes runner.
  describe("the row's platform picks the artifact", () => {
    it("serves a shell script for a Docker runner", async () => {
      const res = await get(DOCKER_TOKEN);
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/x-shellscript/);
      expect(res.body).toContain("docker run -d");
    });

    it("serves a Kubernetes manifest for a Kubernetes runner", async () => {
      const res = await get(K8S_TOKEN);
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toMatch(/application\/yaml/);
      expect(res.body).toContain("kind: Deployment");
      expect(res.body).not.toContain("docker run");
    });

    it("gives each platform its own image", async () => {
      const docker = await get(DOCKER_TOKEN);
      const kubernetes = await get(K8S_TOKEN);
      expect(docker.body).toContain("nightwarden-docker-runner");
      expect(kubernetes.body).toContain("nightwarden-kubernetes-runner");
    });
  });

  describe("the address a runner dials back on", () => {
    it("uses ws:// for a plain HTTP request", async () => {
      const res = await get(DOCKER_TOKEN, { host: "control.example.com:3000" });
      expect(res.body).toContain(
        "ws://control.example.com:3000/api/clients/connect",
      );
    });

    it("uses wss:// when the request is forwarded over TLS", async () => {
      const res = await get(DOCKER_TOKEN, {
        host: "my-host.example.com",
        "x-forwarded-proto": "https",
      });
      expect(res.body).toContain(
        "wss://my-host.example.com/api/clients/connect",
      );
    });

    it("carries the WS URL into the Kubernetes manifest too", async () => {
      const res = await get(K8S_TOKEN, {
        host: "control.example.com:3000",
      });
      expect(res.body).toContain(
        "ws://control.example.com:3000/api/clients/connect",
      );
    });

    it("bakes in PUBLIC_URL over the request Host, so a runner dials the address that is reachable from its own machine", async () => {
      vi.stubEnv("PUBLIC_URL", "https://nightwarden.example.com");
      try {
        // What an operator's browser reached the console on: useless to a runner.
        const res = await get(DOCKER_TOKEN, { host: "localhost:3000" });
        expect(res.body).toContain(
          "wss://nightwarden.example.com/api/clients/connect",
        );
        expect(res.body).not.toContain("localhost:3000");
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  describe("what the artifact carries", () => {
    it("bakes in the runner's own token", async () => {
      const docker = await get(DOCKER_TOKEN);
      const kubernetes = await get(K8S_TOKEN);
      expect(docker.body).toContain(DOCKER_TOKEN);
      expect(kubernetes.body).toContain(K8S_TOKEN);
    });

    // The manifest has no braces of its own, so a bare {{ there is ours. The shell
    // script does: `docker ps --format '{{.Names}}'` is Docker's syntax, not a slot.
    it("leaves no unreplaced placeholders in the Kubernetes manifest", async () => {
      const res = await get(K8S_TOKEN);
      expect(res.body).not.toContain("{{");
      expect(res.body).not.toContain("}}");
    });

    it("fills every slot in the Docker script", async () => {
      const res = await get(DOCKER_TOKEN);
      for (const slot of [
        "{{RUNNER_IMAGE}}",
        "{{WS_URL}}",
        "{{NIGHTWARDEN_TOKEN}}",
      ]) {
        expect(res.body).not.toContain(slot);
      }
    });

    it("passes only what the Docker runner reads: token, ws url, host /proc", async () => {
      const res = await get(DOCKER_TOKEN);
      expect(res.body).toContain('-e "NIGHTWARDEN_TOKEN=');
      expect(res.body).toContain('-e "WS_URL=');
      expect(res.body).toContain('-e "HOST_PROC=/host/proc"');
      // The runner takes its advertised name from the host's own /proc, so the
      // script needs no name baked in and none can be copied wrong.
      expect(res.body).not.toContain("--hostname");
      expect(res.body).toContain("-v /proc:/host/proc:ro");
    });

    it("carries no bundled-monitoring plumbing (unbundled runner)", async () => {
      const res = await get(DOCKER_TOKEN);
      // No sidecar ports, no monitoring env, no ingest credential - alert wiring
      // now lives entirely on the console's Alertmanager page.
      for (const token of [
        "9090",
        "9093",
        "8080",
        "prometheus",
        "alertmanager",
        "cadvisor",
        "PROMETHEUS_URL",
        "ALERTMANAGER_URL",
        "NIGHTWARDEN_INGEST_TOKEN",
        "PLATFORM_URL",
        "nightwarden.sh",
        "inst_",
      ]) {
        expect(res.body).not.toContain(token);
      }
    });
  });
});

// The RBAC the cluster runner is granted is the artifact's real contract, so it
// is pinned against the builder rather than through a request that only re-serves it.
describe("kubernetesInstallManifest", () => {
  const WS_URL = "wss://api.example.com/api/clients/connect";
  const yaml = kubernetesInstallManifest(WS_URL, "nwr_tok");

  it("creates the nightwarden namespace", () => {
    expect(yaml).toContain("kind: Namespace");
    expect(yaml).toContain("name: nightwarden");
  });

  it("includes a single-replica Deployment and a ServiceAccount", () => {
    expect(yaml).toContain("kind: Deployment");
    expect(yaml).toContain("replicas: 1");
    expect(yaml).toContain("kind: ServiceAccount");
  });

  it("binds a ClusterRole for read access", () => {
    expect(yaml).toContain("kind: ClusterRole");
    expect(yaml).toContain("kind: ClusterRoleBinding");
  });

  it("grants read access to every resource the runner enumerates", () => {
    for (const resource of [
      "pods",
      "deployments",
      "statefulsets",
      "daemonsets",
      "replicasets",
      "events",
      "nodes",
      "namespaces",
      "pods/log",
    ]) {
      expect(yaml).toContain(resource);
    }
  });

  it("write ClusterRole grants patch and create on pods/exec", () => {
    const writeStart = yaml.indexOf("name: nightwarden-runner-write");
    const writeEnd = yaml.indexOf("---", writeStart);
    const writeRole = yaml.slice(writeStart, writeEnd);
    expect(writeRole).toContain("patch");
    expect(writeRole).toContain("pods/exec");
    expect(writeRole).toContain('"create"');
  });

  it("passes only what the runner reads: its token and the ws url", () => {
    // Env entries are the `- name:` lines that carry a value; the container's
    // own name has none.
    const envNames = [...yaml.matchAll(/- name: (\w+)\n\s+value:/g)].map(
      (m) => m[1],
    );
    expect(envNames).toEqual(["NIGHTWARDEN_TOKEN", "WS_URL"]);
  });

  it("substitutes the values it was given", () => {
    const token = "nwr_verylongtoken_withspecialchars-123";
    const built = kubernetesInstallManifest(WS_URL, token);
    expect(built).toContain(WS_URL);
    expect(built).toContain(token);
  });
});
