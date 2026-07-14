# Nightwatch

![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)
![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)
![pnpm >= 11](https://img.shields.io/badge/pnpm-%3E%3D11-orange.svg)

Nightwatch is a self-hosted, open-source AI SRE agent for Docker and Kubernetes workloads. It watches your servers and clusters, and when something breaks it investigates the problem on its own, works out the smallest safe fix, and waits for you to approve it before touching anything.

## Why Nightwatch

An alert fires at 3am. Normally that means waking up, SSHing into a box, reading logs, checking `docker ps` or `kubectl get pods`, correlating a recent deploy, and only then deciding what to do. The investigation is slow, manual, and always lands on a tired human.

Nightwatch does that first pass for you. The moment an alert arrives, it starts pulling logs, container or pod state, and host metrics, reasons about the root cause, and drafts a concrete remediation such as restarting a service - or, when the root cause is in your application code and a repository is connected, a code fix proposed as a draft pull request. By the time you look at your screen, the investigation is already written up and a fix is sitting there waiting for one click.

The important part is what it will not do. Nightwatch never changes anything on a server without your explicit approval. It reads freely and acts only on permission, so you get the speed of an automated responder with the safety of a human gate.

## How it works

```mermaid
flowchart LR

%% Infrastructure
cadvisor["cAdvisor"]
prometheus["Prometheus"]
alertmanager["Alertmanager"]
runner["Runner<br/>Docker · Kubernetes · Host Metrics"]

%% Brain
api["Nightwatch API<br/>Node.js · SQLite<br/>Agent Loop · Approvals · Event Bus"]

%% UI
console["Console<br/>Chat · Live Transcript<br/>Approval Cards · Fleet · Settings"]

%% Code
github["GitHub<br/>Draft Pull Requests"]

cadvisor --> prometheus
prometheus --> alertmanager

alertmanager -- POST /alerts/ingest --> api
console -- Start investigation --> api
api -- WebSocket --> runner
api -- REST + SSE --> console
api -- sandboxed code fixes --> github

classDef infra fill:#1b2430,stroke:#4f9cf9,color:#fff,stroke-width:1.5;
classDef api fill:#1d3027,stroke:#4ade80,color:#fff,stroke-width:1.8;
classDef ui fill:#2b243d,stroke:#c084fc,color:#fff,stroke-width:1.5;

class cadvisor,prometheus,alertmanager,runner,github infra;
class api api;
class console ui;

linkStyle default stroke:#888,stroke-width:1.5;
```

When an alert fires, Alertmanager posts it to the API's ingest endpoint. The API opens an investigation session and runs an agentic loop: it calls read-only tools on the relevant runner (service logs, process lists, metrics), feeds the results back to the model, and keeps going until the model proposes a fix or asks you a question. Any action that writes to a server pauses the loop and surfaces an approval card in the console. Nothing resumes until you approve, reject, or answer. When a GitHub repository is connected and the root cause is in the application code itself, the same loop can check the code out into an isolated sandbox on the API host, build and test a fix there, and leave a draft pull request for human review.

### The three pieces

**API** is the brain, and the only place an LLM ever runs. It owns all durable state (a single SQLite file as the system of record, plus sandbox workspaces and generated proxy config in the same state directory), drives the agentic loop, gates every server write behind human approval, and talks to runners exclusively over an outbound-initiated WSS connection. When a GitHub repository is connected it is also the piece that provisions the per-session code sandbox - a hardened Docker container on its own host - and opens draft pull requests.

**Runner** is a stateless executor you install on each server or cluster you want monitored. It opens an outbound WSS connection to the API (so it works behind any firewall or NAT, with no inbound ports), advertises what it can do (Docker containers, Kubernetes workloads, or both), and executes the commands the API sends against whichever provider a service actually runs on. It also bundles its own Prometheus, Alertmanager, and cAdvisor as sidecar processes for host and container metrics, so a single install command gives you both the executor and the monitoring stack. It keeps no local state of its own - identity and configuration come entirely from its token and environment.

**Console** is the operator UI: a live, streaming session transcript, approval and clarification cards, the runner fleet view, and settings.

## Features

- **Docker and Kubernetes.** A runner detects and advertises both providers on connect. Tools that are provider-agnostic (logs, restart, exec) work against either; a handful of Kubernetes-only tools (rollout status, node status) show up automatically when a cluster is available.
- **Human-in-the-loop by default.** Write actions like `RestartService` and `ServiceBash` require explicit approval. Read actions run automatically so the agent can investigate without waiting on you.
- **Code fixes as draft pull requests.** Connect a GitHub repository and the agent can read the code, build and test a fix inside a hardened per-session Docker sandbox on the API host, and propose it as a draft pull request. A human always reviews and merges on GitHub - Nightwatch never merges.
- **Durable suspend and resume.** A pending approval survives an API restart. You can approve hours later and the agent picks up exactly where it left off, because nothing is held in memory while it waits.
- **Works behind NAT.** Runners dial out to the API over WSS. There are no inbound ports to open on your servers.
- **Bring your own key.** Use Anthropic, OpenAI, or any OpenAI-compatible endpoint (OpenRouter, Groq, Ollama). Inference goes straight to your provider and your key never leaves your network.
- **Multi-server.** One API coordinates as many runners as you have servers or clusters, and a single investigation can span more than one runner.
- **No external infrastructure.** State lives in one SQLite file. There is no Redis, no Postgres, and no message queue to run.
- **Self-contained runner.** Each runner ships with Prometheus, Alertmanager, and cAdvisor built in, so the target server needs nothing installed beyond the one-liner.

## Getting started

You need Node.js 20 or newer, pnpm 11 or newer, and an Anthropic or OpenAI-compatible API key.

### 1. Clone and install

```bash
git clone https://github.com/Flux690/nightwatch
cd nightwatch
pnpm install
```

### 2. Configure the API

```bash
cp apps/api/.env.example apps/api/.env
```

Open `apps/api/.env` and set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` - or leave it unset and paste the key into the console's Settings after boot, where it is stored encrypted and takes precedence over the env var. Everything else has defaults; the full list of variables is in [Configuration](#configuration).

### 3. Start everything

```bash
pnpm dev
```

This runs the API on port 3000 and the console on port 5173 with live reload. Open `http://localhost:5173` and set an owner password on first visit.

### 4. Connect a runner

In the console go to **Fleet**, then **Add a server**. The wizard walks you through three steps and needs no manual config editing:

1. **Server details** - pick the substrate (Docker or Kubernetes), name the server, and choose how it gets monitored: **"Bundle Prometheus + Alertmanager for me"**, or **"I already run my own monitoring"**.
2. **Install the runner** - Nightwatch mints a runner token and shows a ready-to-run install command with the token baked in. Copy it and run it on the target server or cluster.
   - If you chose bundled monitoring, that's it - Prometheus, Alertmanager, and cAdvisor ship inside the runner and are wired up automatically.
   - If you chose bring-your-own, the wizard also shows the webhook URL, bearer token, and Alertmanager receiver snippet to wire your own stack (generated for you, not something you write by hand), plus a **Test webhook** button to confirm it's wired correctly before moving on. This ingest credential is one fleet-wide secret, not one per server - it's minted the first time any server needs it and every bring-your-own server after that reuses the same one; the wizard's per-server snippet only changes the Prometheus `server` external label so Nightwatch can tell your servers apart.
3. **Verify the pipeline** - send a synthetic alert through the full path and confirm it reaches the runner.

The runner appears in your fleet within seconds of the install command running. If you ever need the ingest credential again outside the wizard - say, to point a pre-existing Alertmanager at Nightwatch directly - **Settings** has a section to reveal or rotate it. The ingest endpoint accepts the token via either an `Authorization: Bearer` header or an `X-Nightwatch-Token` header and speaks the Alertmanager webhook format, recognizing it by the shape of the body (`{ alerts: [...] }`) rather than by any client-controlled header. You can also start an investigation at any time from the console chat, with no alert source at all.

## Configuration

### API (`apps/api/.env`)

| Variable | Required | Description |
|---|---|---|
| `LLM_PROVIDER` | no | `anthropic` or `openai`. Any value other than `openai` resolves to `anthropic` (default: `anthropic`). |
| `ANTHROPIC_API_KEY` | one of | Anthropic API key, used when the provider is `anthropic`. A key saved from console Settings (stored encrypted) takes precedence. |
| `OPENAI_API_KEY` | one of | OpenAI or OpenAI-compatible key, used when the provider is `openai`. A key saved from console Settings (stored encrypted) takes precedence. |
| `OPENAI_BASE_URL` | no | Base URL for OpenAI-compatible providers, e.g. `https://openrouter.ai/api/v1`. |
| `ANTHROPIC_MODEL` | no | Model id for the Anthropic provider (default: `claude-sonnet-4-6`). |
| `OPENAI_MODEL` | no | Model id for the OpenAI provider (default: `openai/gpt-oss-120b:free`). |
| `PORT` | no | HTTP port the API listens on (default: `3000`). |
| `HOST` | no | Bind address (default: `127.0.0.1`). |
| `NIGHTWATCH_DIR` | no | Absolute path to the directory holding all durable state: `nightwatch.db`, `secret.key`, the per-session GitHub sandbox `workspaces/`, and the generated egress-proxy config `proxy/`. Defaults to `~/.nightwatch`; created on boot if missing. Must be absolute (a relative value fails at boot); on a Mac keep it under your home so Docker Desktop's file sharing covers the sandbox mounts. |
| `SECRET_KEY` | no | AES-256-GCM key that signs owner sessions and encrypts the stored LLM key. If unset, the API generates one on first boot and writes it to a `0600` `secret.key` file in `NIGHTWATCH_DIR`, then reuses it on every restart. Deleting that file is the same as rotating the key: it invalidates every owner session and makes the stored LLM key unrecoverable, so it reads back as unset. Set this explicitly if you want to manage the value yourself. |
| `LOG_LEVEL` | no | Pino log level for the API process, e.g. `debug`, `info`, `warn`, `error` (default: `info`). |

### GitHub integration

Connecting a repository (console → Integrations) lets investigations read the
code, build and test a fix in an isolated checkout, and propose it as a draft
pull request that a human reviews and merges on GitHub - Nightwatch never
merges. Requirements and properties:

- **Docker and git must be installed on the API host** - each code session runs
  in a hardened container there, from a `nightwatch-sandbox` image built
  locally on top of `node:24` (rebuilt automatically whenever its definition
  changes). Prerequisites are checked when you click Connect, not at 3am. If
  the API itself runs in a container it needs the Docker socket mounted.
- **The token stays out of reach.** The connect page deep-links to a
  fine-grained token with exactly Contents and Pull requests (write) on the one
  repository and a 90-day expiry; the console shows the remaining days and
  warns as it nears, and organizations that block fine-grained tokens can use
  a classic PAT instead. The token is encrypted at rest, never returned by any
  endpoint, never enters the sandbox container, and never appears in any URL
  or log: git runs host-side against the bind-mounted checkout and
  authenticates per invocation, so nothing lands in `.git/config`.
  Disconnecting tears down live sandboxes first, then deletes Nightwatch's
  stored copy - full invalidation means revoking the token on GitHub.
- **Container hardening**: read-only root filesystem (the writable surfaces are
  exactly the checkout, the sandbox home, and a bounded `/tmp`), all Linux
  capabilities dropped, no-new-privileges, real CPU/memory caps (swap pinned so
  the memory limit can't be doubled; both are Settings knobs), a fork-bomb PID
  limit and an open-files limit, and the sandbox runs as the API process's own
  non-root user - the API warns at boot when it runs as root, because its
  sandboxes then do too. gVisor (`runsc`) is used automatically wherever the
  Docker host provides it; the sandbox settings can require it. The worst code
  outcome under injection is a commit on a `nightwatch/*` branch inside a
  draft PR behind GitHub's human merge gate.
- **Egress is allowlisted** (Settings → Sandbox, default). All sandbox traffic
  is forced through a shared filtering proxy - built locally from Alpine's own
  tinyproxy package, so no third-party proxy image enters the supply chain -
  that only reaches the allowlisted hosts, out of the box the npm and yarn
  registries. The agent installs what it needs itself (dependencies, global
  CLI tools into its writable home); a blocked host fails loudly, and the
  agent is instructed to name any legitimately needed one in the PR so you can
  extend the list. Container loopback is untouched, so the repo's own local
  test servers still work. The other two modes: "None" gives the container no
  network at all (dependency installs are skipped), "Open" keeps the default
  Docker bridge attached - accepting that a prompt-injected agent could then
  exfiltrate repository content.
- **Provisioning is deterministic and visible.** A session's sandbox clones the
  repo onto that session's own `nightwatch/*` branch (a resumed session finds
  its branch on the remote and continues it) and, when the repo pins
  `packageManager` or has a Node lockfile, installs dependencies up front - a
  pinned pnpm or yarn runs through corepack at its exact pinned version. Each
  stage (cloning, starting, installing) streams live to the console
  transcript. A failed install is survivable - read, edit, and PR keep
  working - and its output tail reaches the logs and the agent, which is told
  to fix or work around it before building or testing.
- **Opening the PR is deliberately not approval-gated.** The PR is a draft
  proposal; the repository's own CI and the human merge are the review layers,
  and gating creation would stall the very 3am flow this exists for. The agent
  is instructed to verify with the repo's own build and tests first and state
  in the PR body what it ran; Nightwatch appends the incident context, the
  changed files, and a session reference. One session maps to one branch and
  at most one open PR - calling the tool again pushes the newest commits and
  updates it - and every PR action is recorded write-ahead in the audit log,
  so after a crash an action with an unknown outcome refuses to blindly run
  again. (Repos whose GitHub plan lacks draft PRs get a normal PR, and the
  tool result says so.)
- **Work survives every death mode.** Files must be read before they can be
  edited, edits come back as real diffs in the transcript, and a sandbox that
  idles out (default one hour, a Settings knob, alongside the session time
  budget every repo tool call extends) checkpoint-commits and pushes its
  branch before the container and checkout are removed. At boot the API reaps
  orphaned sandbox containers and salvages orphaned workspaces the same way -
  commit, push, then remove, with a failed push keeping the folder for manual
  recovery - before accepting sessions, so even an API crash mid-edit leaves
  the work on its branch rather than gone.
- We recommend enabling branch protection on the repository's default branch
  (GitHub → Settings → Branches); Nightwatch's token deliberately has no
  Administration permission and cannot do this for you.

### Runner (`apps/runner/.env`)

| Variable | Required | Description |
|---|---|---|
| `NIGHTWATCH_TOKEN` | yes | Runner credential minted from the console |
| `WS_URL` | yes | API WebSocket endpoint, e.g. `wss://your-api/clients/connect` |
| `HOST_PROC` | no | `/proc` mount path when running inside a container (default: `/proc`) |
| `NIGHTWATCH_SERVER_NAME` | no | Server label attached to Docker service identities on this host, so alerts and tool calls can disambiguate the same container name across servers. |
| `NIGHTWATCH_CLUSTER_NAME` | no | Cluster label attached to Kubernetes service identities, so alerts and tool calls can disambiguate the same namespace/workload across clusters. Unset means a single, unscoped cluster identity. |
| `FILE_ALLOWLIST` | no | Colon-separated paths appended to the built-in allowlist for the `ReadHostFile` tool. |
| `LOG_LEVEL` | no | Pino log level for the runner process (default: `info`). |

Kubernetes access comes from the runner's kubeconfig or in-cluster service account (via `@kubernetes/client-node`) - there is no Kubernetes-specific env var beyond the two identity labels above. `POSTGRES_URL` and `REDIS_URL`, if present on the host, are only probed to advertise availability to the agent as investigation context; they are unrelated to Nightwatch's own storage, which is always the API's single SQLite file. Remediation mode (whether write tools like `restart_service`/`exec_command` are available) has no runner env var at all - it is stored per runner in the API's database and pushed live to the runner over its WebSocket connection whenever you toggle it from the console.

## Development

`pnpm dev` is all you need for day-to-day work; it runs every app from source with live reload, so there is no build step involved.

To exercise the alert pipeline locally without deploying a runner, start the bundled monitoring stack. It runs cAdvisor, Prometheus, and Alertmanager in Docker and points them at your local API, so a real alert can flow end to end on your machine:

```bash
pnpm dev:infra
```

Type-check and run the test suites across every package:

```bash
pnpm typecheck
pnpm test
```

A production build (compiled output for deployment) is available with:

```bash
pnpm build
```

### Monorepo layout

Nightwatch is a pnpm workspace. Apps consume shared code only through the `@nightwatch/shared` package, never through relative paths.

```
apps/
  api/                  Fastify API: the brain
    src/
      agent/            agentic loop, prompts/, tools/ (per-domain schemas assembled in toolset.ts)
      alerts/           Alertmanager ingest, dedup, batching
      auth/             owner password, runner token minting, fleet ingest credential
      config/           settings routes, LLM config, state-directory paths
      db/               SQLite schema and table modules (FKs on, no migrations)
      integrations/     GitHub client and connect/status routes
      llm/              provider factory (Anthropic / OpenAI)
      remediation/      remediation-mode toggle routes
      runners/          runner registry, connect.sh handler
      sandbox/          per-session code sandbox: container lifecycle, git, install, egress proxy, boot salvage, repo tool handlers
      session/          session routes, console event bus (SSE), interrupt coordinator + approval executor
      ws/               runner registry/routing, command transport
      dispatcher.ts     single entry point for every investigation
  runner/               Stateless executor: the hands
    src/
      commands/         provider-agnostic dispatch (registry.ts) + host, file tools
      docker/           dockerode client, container commands, service resolution
      kubernetes/       @kubernetes/client-node client, workload commands, service resolution
      manifest/         capability advertisement to the API (docker, kubernetes, host metrics)
      safety/           command allowlist and secret redaction
      websocket/        outbound WSS client to the API
  console/              React operator UI
    src/
      api/              one typed fetch boundary (apiFetch)
      auth/             login and owner-password setup
      components/
        ui/             shadcn-style primitives
        layout/         shell, sidebar, settings modal, wizard chrome
        transcript/     transcript dispatcher + per-card panels
      hooks/            shared console event-stream (SSE) provider, attention counter
      lib/              shared client helpers (utils, toast, time, icon/status variants)
      pages/            login, fleet, add-server wizard, session view, audit log, integrations + GitHub connect
packages/
  shared/               Shared TypeScript types: the contract
    src/
      ws.ts             runner wire protocol
      console-events.ts console event envelopes
      service-identity.ts docker/kubernetes service identity shapes
      tools.ts          tool input/output payload types (schemas themselves live in apps/api/src/agent/tools/)
      sessions.ts       session and message shapes
      approvals.ts      approval and clarification shapes
      config.ts         agent + sandbox settings shape
      integrations.ts   GitHub integration payloads
      alerts.ts         normalized alert shapes
      auth.ts           owner auth payloads
      remediation.ts    remediation status + audit shapes
      runner.ts         runner and service manifest shapes
```

## License

Nightwatch is licensed under the [GNU Affero General Public License v3.0](LICENSE). If you run a modified version as a network service, you must make your source available to its users.

For commercial or proprietary use outside the terms of the AGPL, contact the maintainers about a separate license.
