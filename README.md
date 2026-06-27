# Nightwatch

![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)
![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)
![pnpm >= 11](https://img.shields.io/badge/pnpm-%3E%3D11-orange.svg)

Nightwatch is a self-hosted, open-source AI SRE agent for Docker workloads. It watches your servers, and when something breaks it investigates the problem on its own, works out the smallest safe fix, and waits for you to approve it before touching anything.

## Why Nightwatch

An alert fires at 3am. Normally that means waking up, SSHing into a box, reading logs, checking `docker ps`, correlating a recent deploy, and only then deciding what to do. The investigation is slow, manual, and always lands on a tired human.

Nightwatch does that first pass for you. The moment an alert arrives, it starts pulling logs, container state, host metrics, and recent deploys, reasons about the root cause, and drafts a concrete remediation such as restarting a container or rolling back a deploy. By the time you look at your screen, the investigation is already written up and a fix is sitting there waiting for one click.

The important part is what it will not do. Nightwatch never changes anything on a server without your explicit approval. It reads freely and acts only on permission, so you get the speed of an automated responder with the safety of a human gate.

## How it works

```
Each monitored server                                    Operator
  cAdvisor -> Prometheus -> Alertmanager --> POST /alerts/ingest --+
                                              Console chat ---------+
                                                                    |
                                                                    v
                                       API  (Node, SQLite)
                                       agentic loop, approvals, event bus
                                             |  wss://         |  REST + WS
                                             v                 v
                                        Runner(s)           Console
                                        docker socket        live transcript
                                        /proc, metrics       approval cards
                                                             fleet, settings
```

When an alert fires, Alertmanager posts it to the API's ingest endpoint. The API opens an investigation session and runs an agentic loop: it calls read-only tools on the relevant runner (container logs, process lists, metrics, recent commits), feeds the results back to the model, and keeps going until the model proposes a fix or asks you a question. Any action that writes to a server pauses the loop and surfaces an approval card in the console. Nothing resumes until you approve, reject, or answer.

### The three pieces

**API** is the brain, and the only place an LLM ever runs. It owns all durable state in a single SQLite file, drives the agentic loop, gates every write action behind human approval, and talks to runners exclusively over an outbound-initiated WSS connection.

**Runner** is a stateless executor you install on each server you want monitored. It opens an outbound WSS connection to the API (so it works behind any firewall or NAT, with no inbound ports), advertises what it can do, and executes the commands the API sends. It also bundles its own Prometheus, Alertmanager, and cAdvisor as sidecar processes, so a single install command gives you both the executor and the full monitoring stack. The only file it ever writes locally is its own runner id.

**Console** is the operator UI: a live, streaming session transcript, approval and clarification cards, the runner fleet view, and settings.

## Features

- **Human-in-the-loop by default.** Write actions like `restart_service` and `exec_command` require explicit approval. Read actions run automatically so the agent can investigate without waiting on you.
- **Durable suspend and resume.** A pending approval survives an API restart. You can approve hours later and the agent picks up exactly where it left off, because nothing is held in memory while it waits.
- **Works behind NAT.** Runners dial out to the API over WSS. There are no inbound ports to open on your servers.
- **Bring your own key.** Use Anthropic, OpenAI, or any OpenAI-compatible endpoint (OpenRouter, Groq, Ollama). Inference goes straight to your provider and your key never leaves your network.
- **Multi-server.** One API coordinates as many runners as you have servers, and a single investigation can span more than one runner.
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

Open `apps/api/.env` and set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. That is the only required value to boot; the full list of variables and their defaults is in [Configuration](#configuration).

### 3. Start everything

```bash
pnpm dev
```

This runs the API on port 3000 and the console on port 5173 with live reload. Open `http://localhost:5173` and set an owner password on first visit.

### 4. Connect a runner

In the console go to **Runners**, then **Add a server**. Nightwatch mints a runner token and shows you a ready-to-run install script with the token already baked in. Copy it and run it on the server you want to monitor:

```bash
# paste the script shown in the console; it runs the runner container via docker
```

The runner appears in your fleet within seconds. It brings its own Prometheus, Alertmanager, and cAdvisor, so there is nothing else to install on that server.

### 5. Connect an existing Alertmanager (optional)

Each runner's bundled Alertmanager already posts alerts to the API. If you run your own Alertmanager and want it to feed Nightwatch too, point a receiver at the ingest endpoint and authenticate with a runner token. The endpoint reads the token from either an `Authorization: Bearer` header or an `X-Nightwatch-Token` header; Alertmanager's `http_config.authorization` sets the former:

```yaml
# alertmanager.yml
receivers:
  - name: nightwatch
    webhook_configs:
      - url: https://your-api/alerts/ingest
        http_config:
          authorization:
            type: Bearer
            credentials: nwr_your_runner_token
```

The ingest endpoint speaks the Alertmanager webhook format and identifies the source by its `Alertmanager` user-agent. You can also start an investigation at any time from the console chat, with no alert source at all.

## Configuration

### API (`apps/api/.env`)

| Variable | Required | Description |
|---|---|---|
| `LLM_PROVIDER` | no | `anthropic` or `openai`. Any value other than `openai` resolves to `anthropic` (default: `anthropic`). |
| `ANTHROPIC_API_KEY` | one of | Anthropic API key. Required when the provider is `anthropic`. |
| `OPENAI_API_KEY` | one of | OpenAI or OpenAI-compatible key. Required when the provider is `openai`. |
| `OPENAI_BASE_URL` | no | Base URL for OpenAI-compatible providers, e.g. `https://openrouter.ai/api/v1`. |
| `ANTHROPIC_MODEL` | no | Model id for the Anthropic provider (default: `claude-sonnet-4-6`). |
| `OPENAI_MODEL` | no | Model id for the OpenAI provider (default: `openai/gpt-oss-120b:free`). |
| `PORT` | no | HTTP port the API listens on (default: `3000`). |
| `HOST` | no | Bind address (default: `127.0.0.1`). |
| `NIGHTWATCH_DB_PATH` | no | Path to the SQLite file (default: `/var/nightwatch/nightwatch.db`). The parent directory is created on boot if it does not exist. |
| `SECRET_KEY` | no | AES-256-GCM key that signs owner sessions and encrypts the stored LLM key. If unset, the API generates one on first boot and writes it to a `0600` `secret.key` file beside the database, then reuses it on every restart. Deleting that file is the same as rotating the key: it invalidates every owner session and makes the stored LLM key unrecoverable, so it reads back as unset. Set this explicitly if you want to manage the value yourself. |
| `GITHUB_TOKEN` | no | Enables the `get_recent_commits` tool so the agent can correlate alerts with recent deploys. |
| `INVESTIGATION_CONCURRENCY` | no | Maximum investigations running at once (default: `5`). |
| `INVESTIGATION_QUEUE_MAX` | no | Bounded in-memory backlog size; overflow is dropped and the alert re-fires (default: `100`). |

### Runner (`apps/runner/.env`)

| Variable | Required | Description |
|---|---|---|
| `NIGHTWATCH_TOKEN` | yes | Runner credential minted from the console |
| `WS_URL` | yes | API WebSocket endpoint, e.g. `wss://your-api/clients/connect` |
| `REMEDIATION_ENABLED` | no | Install-time default for remediation mode; `true` makes write actions (`restart_service`, `exec_command`) available, still behind approval. Disabled by default; toggled live per runner from the console afterwards |
| `HOST_PROC` | no | `/proc` mount path when running inside a container (default: `/proc`) |

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
      agent/            agentic loop, tools, prompt context
      alerts/           Alertmanager ingest, dedup, batching
      auth/             owner password, runner token minting
      config/           settings routes and LLM config
      db/               SQLite schema and table modules (FKs on, no migrations)
      llm/              provider factory (Anthropic / OpenAI)
      runners/          runner registry, connect.sh handler
      session/          session routes, interrupt coordinator + approval executor
      ws/               runner registry/routing, command transport, console bus
      dispatcher.ts     single entry point for every investigation
  runner/               Stateless executor: the hands
    src/
      commands/         read tools (container, host, files, deploy) + remediation
      manifest/         capability advertisement to the API
      metrics/          host and container metric collection
      safety/           command allowlist and secret redaction
      websocket/        outbound WSS client to the API
  console/              React operator UI
    src/
      api/              one typed fetch boundary (apiFetch)
      auth/             login and owner-password setup
      hooks/            shared console WebSocket provider, attention counter
      pages/            shell, session view, sidebar, runners, settings
      transcript/       transcript dispatcher + per-card panels
      utils/            shared client helpers
packages/
  shared/               Shared TypeScript types: the contract
    src/
      ws.ts             runner wire protocol
      console-events.ts console event envelopes
      tools.ts          LLM tool schemas
      sessions.ts       session and message shapes
      approvals.ts      approval and clarification shapes
```

## License

Nightwatch is licensed under the [GNU Affero General Public License v3.0](LICENSE). If you run a modified version as a network service, you must make your source available to its users.

For commercial or proprietary use outside the terms of the AGPL, contact the maintainers about a separate license.
