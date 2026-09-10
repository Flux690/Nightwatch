# NightWarden architecture

The reference for how NightWarden is built: what each process owns, what every term means, and what the system does in each situation. [README.md](README.md) introduces the product; this document is the detail behind it. Where this document and the code disagree, the code is correct and this is a bug.

## Contents

- [Deployables](#deployables) - the three programs and what each owns
- [Durable state](#durable-state) - the database, its tables, and the rule about who may touch them
- [Vocabulary](#vocabulary) - every domain term, defined once
- [Session lifecycle](#session-lifecycle) - status, seats, queueing, restart, failure
- [The agent loop](#the-agent-loop) - prompt assembly, turns, the approval gate, compaction
- [The record](#the-record) - hypotheses, evidence ids, citability, the report turn
- [Evidence sources](#evidence-sources) - what each integration answers, and where results stop
- [Connecting integrations](#connecting-integrations) - what each card asks for and why
- [Operations](#operations) - state directory, privileges, TLS, backup, upgrade
- [Configuration](#configuration) - every environment variable
- [Development](#development) - running from source and the four checks

---

## Deployables

Three programs ship as three images. `apps/` holds exactly what is deployed; `packages/` holds libraries shared across them.

| Program           | Package                          | Owns                                                                                                                  |
| ----------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| API               | `@nightwarden/api`               | All durable state, the agent loop, the LLM calls, the approval gate, code sandboxes, and the built frontend it serves |
| Docker runner     | `@nightwarden/docker-runner`     | Executing Docker and host commands on one machine                                                                     |
| Kubernetes runner | `@nightwarden/kubernetes-runner` | Executing Kubernetes commands against one cluster                                                                     |

The frontend (`@nightwarden/frontend`) is not a deployable. Vite bundles it and the API build copies it into `dist/frontend`, so one origin serves the browser, the webhooks and the runner sockets. There is no `api.` subdomain, no CORS, and no version skew between frontend and API.

**The two runners are two programs, not one program with a switch.** A single image would carry both platform clients and a conditional deciding which to use, when which platform a runner serves is already fixed at onboarding. Nothing is shared between them by reaching across a directory: common code goes through `@nightwarden/runner-core` (the WS client, wire decoders, redaction, logger, runner identity) or is duplicated deliberately. `apps/api/src/tests/architecture.test.ts` fails the build if a runner imports from its sibling.

**A runner never probes for its platform.** Which platform it serves is fixed when its token is issued, stored on the `runner` row, and carried by which binary was installed. The row is authoritative before the runner has ever connected, so routing, the alert matcher and the offered toolset all read it. A runner reports its platform on connect only so a mismatch can be refused loudly.

**Connections are outbound-initiated.** A runner dials the API over WSS, so no inbound port opens on a monitored host and NAT is not an obstacle. The API never dials a runner.

### Module layout inside the API

`apps/api/src` groups by the domain a file serves, never by what kind of file it is. There is no `db/` folder and no `types/` folder.

| Directory       | Serves                                                  |
| --------------- | ------------------------------------------------------- |
| `agent/`        | The loop, prompts, tools, evidence ids, the record      |
| `alerts/`       | Ingest, parsing, grouping, target resolution            |
| `auth/`         | Owner sessions, runner token issuing                    |
| `config/`       | Settings and LLM readiness                              |
| `fleet/`        | Runner connections, manifests, command transport        |
| `integrations/` | Metrics, Loki, Sentry, GitHub connections               |
| `llm/`          | The provider adapter, the model catalogue, their config |
| `sandbox/`      | Per-session code containers and git                     |
| `session/`      | Sessions, transcript, alerts, record, status, gates     |
| `verification/` | Recovery re-checking                                    |

The `src/` root holds two kinds of file and nothing else: infrastructure the process stands on (`db.ts`, `migrations.ts`, `schema.ts`, `logger.ts`, `secrets.ts`, `paths.ts`, `public-url.ts`, `frontend.ts`, `request-body.ts`), which may not import a module, and the composition root (`index.ts`, `dispatcher.ts`, `run-pool.ts`), whose job is to wire modules together. `architecture.test.ts` asserts both directions and that nothing cycles.

---

## Durable state

One SQLite file is the system of record. There is no second store, no cache to invalidate, and no external infrastructure. A runner writes nothing to disk and remembers nothing across restarts.

**Access is through Kysely** on `better-sqlite3`, opened once in `db.ts` with `journal_mode = WAL` and `foreign_keys = ON`. Kysely serialises transactions on SQLite's single connection, which is why nothing here hand-rolls a write queue. Every query is async and every store is awaited.

**Only files ending `store.ts` may obtain a `Db`.** `architecture.test.ts` enforces it, so persistence code has nowhere wrong to go. Today that is `session/{store,transcript-store,alerts-store,record-store,status-store,gate-store}.ts`, `integrations/{store,metrics/store}.ts`, `fleet/runners-store.ts` and `config/store.ts`. Better Auth reaches its own four tables through the same handle rather than a store of ours.

**Schema changes ship as migrations.** `migrations.ts` is an ordered history applied at boot by `db.ts`, frozen from the first release and edited in place before it, each migration in its own `BEGIN IMMEDIATE` transaction. SQLite has transactional DDL, so a failed migration leaves nothing half-applied and its version unrecorded for the next boot to retry. Versions must ascend and each may appear once; the API refuses to start rather than serve a half-migrated schema. `schema.ts` describes the database as it is now and is where a column says what it is for.

| Table                | Holds                                                                                           |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| `sessions`           | One row per session: status, investigation flag, the open gate, the record                      |
| `session_transcript` | Append-only rows keyed `(session_id, seq)`; the durable transcript and evidence trail           |
| `alerts`             | Every alert from arrival, with its labels in a column of their own so `json_each` can read them |
| `runner`             | One row per runner: token hash, platform, server name                                           |
| `integrations`       | One row per connection: kind, JSON config, encrypted secrets, optional inbound token hash       |
| `config`             | Single row of agent and sandbox settings                                                        |
| `provider_config`    | One row per LLM provider: model, base URL, encrypted key, reasoning level                       |
| `user`               | One row per person: name, email, and the admin plugin's role and ban columns                    |
| `auth_session`       | One row per signed-in browser, with its token, expiry, IP and user agent                        |
| `account`            | One row per sign-in method on a user; email and password is one holding the argon2id hash       |
| `verification`       | Short-lived tokens: password resets today, an invite link when one is built                     |
| `schema_migrations`  | Which migrations this database has seen                                                         |

---

## Vocabulary

One word per concept, used identically in the code, the frontend and this document.

### Sessions and alerts

**Session.** One thread with the agent, durable in SQLite. Every unit of the agent's work is a session; there is no second kind.

**Investigation.** A property a session carries, set at creation by an alert firing and never changed afterwards. An investigation is a session with a falsifiable condition attached, and only an alert carries one. No tool moves a session into it and nothing infers it from what the run recorded. It decides exactly two things: whether the record's tool is offered and the run is written up, and which layout the frontend draws.

**Run.** One execution of the agent loop inside a session. A session suspended for approval resumes as a new run against the same session. There is no state beside the status: `running` is claimed by a conditional UPDATE, so the row is the mutex as well as the word, and anything left `running` at boot was killed by the restart.

**Alert.** One notification from the monitoring stack, identified by its fingerprint **and** the instant it started. A fingerprint hashes the labels, so the same condition firing months apart carries the same one, and the start time is what separates the two firings. Matching on the fingerprint alone lets a recovery clear an incident from months earlier. A row exists from the moment it arrives, before anything decides whether there is capacity.

**Alert group.** Which alerts are investigated together, decided by the sender and arriving as data: Alertmanager's `groupKey`, computed from the `group_by` the user configured. One webhook delivery is one group is one investigation. NightWarden never regroups.

**Delivery.** One webhook body. Beyond the alerts it carries the labels the sender grouped on, the labels and annotations every alert holds, and how many it left out. All of it reaches the agent, because the sender has already worked out why these belong together.

**Seat.** One of the concurrent runs a pool allows. `running` or `action_required` holds a seat; everything else holds none. A session waiting on a human keeps its seat, because freeing it only queues a second request behind the same person.

### The fleet

**Fleet.** The set of currently connected runners. Always singular.

**Runner.** An executor installed on one Docker host or one Kubernetes cluster. Its identity is its permanent row id; its token is a rotatable credential. It keeps no durable state but does know what it is.

**Platform.** Docker or Kubernetes. Fixed when the token is issued, stored on the row, and declared by which binary was installed.

**Server.** What the model addresses: one Docker host or one cluster, named when the token is issued. Supplied as the `server` parameter by tools acting on a whole machine, and the first segment of every target key. "Runner" is the operator's word for the program; the model only ever says server.

**Target key.** The canonical address of one service, three segments, `server/scope/name` - for example `web-01/shop/api`. Built only from what the infrastructure publishes, copied verbatim, never assembled by hand.

### The record

**Record.** Everything an investigation holds, in two parts with two authors and two moments: the hypotheses the agent appends as it works, and the report it writes once at the end. A column each on the session.

**Hypothesis.** A candidate explanation the agent tested, recorded once it has been tested, in one act carrying a verdict and at least one citation. There is no unsettled state and no call that rewrites a row.

**Verdict.** How a hypothesis resolved: `root cause`, `trigger`, `symptom`, `contributing factor` or `disproven`. Five, all settled.

**Supersession.** The link a later claim carries to the earlier one it replaces. A link, never an edit: the replaced claim stays on the record and stays rendered, demoted.

**Report.** The user-facing write-up, composed in one call at the end over hypotheses that are already complete. It holds only what they have no field for, so it never restates a verdict or a citation. Null until that call happens, which several endings never reach.

**Recommendation.** One field of the report: what the user should do. Prose about the future, never a claim that something was done.

**Released write.** One gated call the user let through, read back from the transcript rather than from a log of its own. It is also what a later read confirms, which is how a claim earns `verified`.

### Evidence

**Evidence trail.** The durable transcript, walked for its tool calls. Nothing writes a second copy; the agent cites entries and cannot add, remove or renumber them.

**Evidence id.** The handle a claim cites a call by, written `e1`, `e2`, `e3` in the order results returned. Stamped by `resultParts` in `agent/evidence-id.ts` as the answer is built and stored on the result, because a call that has not returned shows nothing anyone can cite. The stored result is the handle's only home; `toolResultText` opens the copy the model reads with `Evidence ID: e1`, so the transcript card and the report draw the answer alone. A citation naming the provider's own call id is refused, and so is one naming a call made in the same reply.

**Citable.** Whether a claim may rest on a call. Declared on the tool as `citable`, which carries the renderer with it, so a tool that observes nothing has neither. Recording a claim, writing the report and asking a person are not observations, so they carry no id and nothing can cite them - which is what stops a run grading its own assertion as evidence for itself. A call that established nothing is issued no id either, whatever tool it named.

**Tool failure.** Whether a call answered at all, carried as `isError` on the result part. A call that returned its own shape answered, however empty that shape is: no matching log lines, no series, no issues in the window. A call that could not return its shape did not - a runner it could not reach, a token it was refused, a query the source rejected, a reply nothing could parse, and a subject that does not exist, which is a path or a target key the agent named without listing first. A failed call is issued no evidence id, so nothing can cite it. What a call found is the output's business, so nothing beside it restates that.

**Tool approval.** Whether a person released a write, carried as its own `tool_approval` part beside the result. Written only where someone was asked, so a call the harness refused - which names a gated tool and reached no gate - can never read as approval. An answer to a question is a separate `elicitation_answer` part, because being asked something and permitting a write are different acts.

**Evidence kind.** What a citation is worth drawing as: `metric`, `logs`, `change`, `state`, `diff`, `terminal`, `exception`, `text`. Declared on the tool beside `citable`, so the frontend picks a renderer rather than guessing from the result. The renderer still parses what it was handed, and where it can draw nothing the report says what the call looked at instead.

**Compaction.** Where the provider summarised earlier turns to fit its context window, marked in the transcript as an item of its own. What the model can see narrows; what the run can prove does not. Every tool result stays in full, still cited and still resolvable.

---

## Session lifecycle

### Status

One column on `sessions`. Every value but `running` is derived from the session's own columns and rewritten by the transition that changed one. `running` says a process is executing the session, which no stored row can know, so it is claimed rather than derived.

| Status            | Means                                                                        | Next                                                     |
| ----------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------- |
| `action_required` | A gate is open right now: an approval, a question or a check-in              | Answer it. Nothing proceeds until you do                 |
| `running`         | A process is executing this session. Drawn as _Investigating_                | Nothing to do                                            |
| `resolved`        | Every alert on the session cleared                                           | Nothing. The only status that means the incident is over |
| `completed`       | The run finished and nothing is blocked on you                               | Read what it found or ruled out                          |
| `stopped`         | A person ended it                                                            | Nothing. Send a message to pick it back up               |
| `failed`          | The run crashed, which the last transcript row being an `error` is what says | Retried automatically if the cause was transient         |

`action_required` means something is frozen, and nothing else. A finished investigation whose recommendation nobody acted on is `completed`: nothing marks a recommendation as acted on, so that group could only ever grow.

`resolved` is never inferred. It does not mean a fix ran and never comes from the model saying it found the cause.

### Seats and queueing

Two pools, because an alert storm can produce fifty runs in a minute while chats are self-limiting.

- **Investigations:** `maxConcurrentInvestigations`, default 10, a setting under Settings → Agent.
- **Chats:** `MAX_CONCURRENT_CHATS`, 20, a constant in `run-pool.ts`. A backstop rather than a usage limit, which is why it is not a setting.

Alerts over the cap **wait**; they are never dropped, because the sender was already told the webhook was accepted and has nobody to retry to. Longest-waiting goes first, as a whole group. A chat over the cap is **refused** rather than queued, because someone is watching that request and a message beats a spinner. An alert that recovers while waiting is never investigated at all.

### Deduplication

An alert is a duplicate when some investigation already covers that exact alert and nothing has said the condition recovered. Alertmanager re-sends a still-firing alert on `repeat_interval`, and every repeat is dropped.

Two things are not duplicates: an alert that cleared and later fired again carries a new start time and opens a new investigation, and a different alert in a group already being investigated joins that investigation rather than opening another. A joining alert appears in the transcript at the point it interrupted, and the investigation cannot reach `resolved` until it clears too.

### Restart

One process and one SQLite file, so a restart is the only way work is interrupted. Nothing that matters is held in memory: alerts are written to disk on arrival, before anything decides whether there is a seat.

- **Alerts still waiting** are still waiting, and start when a seat frees.
- **A run that was working** is picked up. A half-finished exchange is repaired where that is safe (a read can be run again) and unwound where it is not. If the alert still fires and the run was recent it continues from its last complete exchange; otherwise it is marked interrupted.
- **A run parked on a gate** is left alone. It is waiting, not broken, and it keeps its seat.

One narrow case sits between them. If the process dies between running an approved command and recording its result, it comes back knowing the command ran but not what it returned. It never runs it again. The investigation stops with a note saying exactly that.

### Failure and retry

A failed run is retried up to three times, minutes apart, on the same schedule that re-checks recovery, and only when waiting could help: a dropped connection, a rate limit, a provider having a bad day. A rejected key, an empty account or a missing model fails identically every time, so those stop and say which one it was. A retry resumes from the last complete exchange.

**A turn that carries no answer says so.** Every reason a provider can report has its own value, and a turn that ended because the output ceiling was reached, a content filter fired, the provider faulted, or for a reason this build does not recognise, writes a line into the transcript naming which. None of them reads as the model having finished, so a run cannot go on to write a report over a turn that answered nothing.

### Recovery

A fix is never believed because the model says so. The condition that fired is re-checked, two independent ways:

1. **The alert source says so.** A resolved notification marks that alert cleared. Alertmanager's `send_resolved` defaults to true and Grafana sends one unless disabled.
2. **NightWarden asks the rules API.** For as long as a condition has not been seen to recover, it asks whether the alerting rule that fired still holds an instance matching this alert - the same rule on the same evaluation interval, not a query NightWarden composed. A `pending` rule counts as still firing. Asked often while the incident is live and progressively less as it ages.

Both write the same record and cross-check each other. If nothing can answer, the record says the fix ran but recovery was not confirmed. It never reads `resolved`. A run that had a write approved and then went quiet while the condition still fires is pushed back and asked what to do; it is never told to try again.

---

## The agent loop

### Prompt assembly

`systemPromptFor` in `agent/context.ts` concatenates blocks in one fixed order, invariant first and varying last, because the stable prefix is what a provider can cache.

| Block                       | Included when   | Carries                                                                                                                                                     |
| --------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IDENTITY`                  | always          | Who the model is, that a claim names a measured value or a line it read, and to answer at the size of what was asked                                        |
| `HARNESS`                   | always          | The approval gate and its required reason, that the offered toolset is final, to batch independent calls, and how to read a `<system-reminder>` turn        |
| `FLEET`                     | `fleetTools`    | Target keys and server names. Withheld when nothing takes one, because pointing at an absent `<fleet-summary>` is how a metrics source once became a target |
| `sandboxInstructions(repo)` | `repo !== null` | The checkout, what is installed in it, and that a pull request opens as a draft a human merges                                                              |
| `INVESTIGATION`             | investigation   | That an alert opened this session, the ordered method, and to prefer the smallest reversible fix                                                            |
| `REPORT`                    | investigation   | That a record is kept, and what a claim must cite to reach it                                                                                               |
| `budgetLine`                | always          | The minutes available. Last, because it is the only block carrying a value that varies                                                                      |

**The base is the whole job, and an investigation adds to it.** Nothing tells the model which branch it is not on. A chat has no record tool to be told not to use, because `effectiveToolset` withholds `REPORT_TOOLS` entirely.

### What the agent is handed about an alert

Everything the alert carried and nothing invented: labels, annotations, when it fired, and the service it resolves to when the fleet advertises one. Also the PromQL expression that fired, decoded from the link Prometheus puts in the alert, and the values the rule evaluated to where the sender reports them.

**Annotations are text and are never dereferenced.** A `runbook_url` reaches the model as a fact and nothing follows it: fetching a URL out of an alert body is a request an attacker who can write an annotation would be choosing for you.

### The harness marker

A provider offers two roles and neither is ours, so anything the harness says arrives in the role a person's message uses. NightWarden marks its own turns `<system-reminder>` and **strips that marker from every source it did not write**: what the user types, what a question is answered with, what a tool returns, and what an alert carried. Stripping happens at one door, `executeTool` in `agent/tools/toolset.ts`, rather than in each tool.

The marker means something only because of the strip. Unstripped it is worse than absent: a log line on a monitored host could close the tag and open its own, so hostile text impersonates the system rather than having to argue with the model.

Other tags are section labels, not voices, and stay out of this namespace: `<alert>` and `<group>` fence text the sender wrote, `<fleet-summary>` is a landmark the addressing rules name, `<previous-report>` labels a quotation of the model's own earlier words.

### How a tool is declared

**A tool's shape is written once, as a Zod object, and the schema the model reads is generated from it.** `apiTool` in `agent/tools/schema.ts` declares an api-side tool, binding that object to the handler so the two cannot name different shapes: the handler's parameter type is inferred from the schema rather than annotated beside it. `Tool`'s `execute` is a property rather than a method for that reason alone - method shorthand is bivariant, so it would accept a handler typed to another tool's schema. `declareTool` serves the runner-routed tools and the elicitation, which carry no handler. `executeTool` parses with the object before dispatch, so no handler validates its own arguments, and a runner-routed call is checked before it reaches a monitored host. Field descriptions ride on `.meta()`, and **property order follows the Zod object's declaration order** - reordering fields there reorders what the model is asked for, which is why `RecordHypothesis` puts its finding ahead of its verdict.

**Three rules govern a bound, and none of them names a provider.** Zod enforces every bound at runtime, always, whichever provider the run picked; that is the only guarantee. The description states every bound, always, because a description is written before anyone knows which provider will run - `tool-schema.test.ts` fails a field whose own description does not state its bound, and an argument past a bound is refused rather than quietly clamped. And each provider's schema carries the maximum that provider accepts.

**Which keywords a provider accepts is that provider's business.** `toolSchema` emits the whole generated schema, and `llm/tool-schema-dialects.ts` reduces it per provider from that provider's published list. Both keep the structural keywords and `default`, which OpenAI needs because its strict mode requires every field and a defaulted one arrives nullable. On top of those `anthropicToolSchema` keeps `minItems` at 0 or 1 and `format` at the ten values Anthropic names; `openAIToolSchema` keeps neither, and widens every optional field into a nullable union. That widening has no way to say a field was skipped, so `parseInput` reads a null as the omission it means. Both drop the numeric and string bounds neither grammar can express. The reducers copy rather than edit, since one generated schema is read by whichever provider the run picked. `tool-schema.test.ts` asserts per dialect that no keyword outside that provider's list survives at any depth, so a tool adding one fails the build rather than reaching a request.

### The gate

**What a tool does and what the operator permits are two facts, recorded apart.** Both are declared on the tool in `agent/tools/types.ts`, so there is no separate list that could fall out of step.

- `effect` is `read` or `write`, a property of the call.
- `policy` is `auto` or `approve`, resolved per call by `resolvePolicy`.

Of 44 tools, 36 read and 8 write. Only four suspend for approval, and the four writes that do not state why:

| Tool                                 | Effect | Policy    | Why                                                           |
| ------------------------------------ | ------ | --------- | ------------------------------------------------------------- |
| `RestartDockerService`, `DockerExec` | write  | `approve` | Leaves the API for a machine you own                          |
| `RestartK8sWorkload`, `K8sExec`      | write  | `approve` | As above                                                      |
| `Edit`, `Write`, `Bash`              | write  | `auto`    | Lands in a disposable sandbox container on a throwaway branch |
| `OpenPullRequest`                    | write  | `auto`    | Opens a draft behind GitHub's own human merge gate            |

`policy-gate.test.ts` asserts both directions from the registry: every runner write is `approve`, and the set of ungated writes is exactly those four api-side names. A tool added with the wrong policy fails that test rather than shipping.

**Every gated call carries a `reason`** as a required argument on the call itself, shown on the approval card. A write to gather evidence and a write to remediate are both legitimate; the reason says which.

**A rejection is reported as a rejection.** The agent is told the user refused and that nothing changed, so it redirects rather than retrying. When the same write has already run in this investigation, the card says how many times - restarting a service a fifth time is a decision, not a mistake, so it is reported and never refused.

**A gated call ends the turn.** It suspends the run, so nothing the model asked for after it runs; each such call is answered for reissue on the next turn, because a read after it would carry the state from before the approval and a later gated call's reason was written against a world the first had not yet changed.

### Asking a human is not a tool

An elicitation is offered to the model as one, because tool-calling is the only channel it has to request anything. It carries no implementation and no policy: it always suspends, and no operator setting can switch that off. `AskUserQuestion` offers at most four options and always a free-text box beside them.

**The two interruptions sit differently, because they stop different amounts.** An approval holds up one tool call, so its card stays inline in the transcript and you can scroll past it. A question holds up the whole run, so it pins above the message box until answered. Once settled, either becomes an ordinary transcript line carrying what was decided.

### Turn execution and limits

`agent/loop/turn.ts` classifies a turn's tool calls first, with no I/O, then runs them in the order the model emitted them: a run of consecutive reads goes out together, and an auto write runs alone in its slot, so a read asked for after it still sees what it did. A gated write suspends the turn instead, so nothing the model asked for after it runs. A result keeps the position its call was emitted in, which is what holds evidence ids steady whatever the timing does. A single tool result may occupy **30,000 characters** (`MAX_TOOL_RESULT_CHARS`). Tools that can return a lot drop whole items to stay under it and say in the result what they left out.

A result still over the line is refused **whole**, and the agent is told to narrow the call. It is never truncated: half a JSON result parses cleanly as a smaller truth, and a list of three failing pods cut to two reads as two failing pods with nothing about it looking wrong.

Default tool timeout is 15s (`DEFAULT_TOOL_TIMEOUT_MS`), overridden per tool where the work justifies it - repo tools run clones, installs and test suites. A caller supplies a ceiling and a tool's own limit can only narrow it. `executeTool` resolves the two into one figure and hands the call both the number and an `AbortSignal` carrying it, so a client that reaches the network is bound by the compiler rather than by convention. Nothing the API dials is unbounded: a call made outside a run carries the bound of whatever asked for it - `PROBE_TIMEOUT_MS` for a Connect probe and the recovery re-check, `CATALOG_TIMEOUT_MS` for listing models, `GITHUB_TIMEOUT_MS` for the pull-request calls a cached sandbox outlives its own tool call to make.

### What a model can do

`provider_config` holds the choices: the model, the base URL, the encrypted key and the reasoning level. A model's context window, output ceiling, effort ladder and compaction support come from the catalogue, resolved when a run reaches `checkLLMReadiness`, so each run describes the model as it is published that day.

**Each field comes from the provider that publishes it, and the models.dev snapshot answers the rest.** Anthropic's `/v1/models` carries the window, the output cap, the effort ladder and the compaction flag. OpenRouter's carries the window, the completion cap, the effort ladder and the parameters it accepts, which is where tool support is stated. OpenAI's carries the model ids alone, so its capabilities come from the snapshot. Tool calling comes from the snapshot wherever a provider is silent about it, and a model that cannot call one stays off the list, because it cannot run the loop.

Two caches sit behind that, both in the API: the snapshot for a day, each provider's merged list for an hour. A run resolves from them without a request, and a provider that cannot be reached leaves the previous answer in place. The settings form receives an id and a reasoning ladder, which is what it draws; the limits are read where the run needs them.

**Listing models checks the key on the providers that require one to list.** Anthropic and OpenAI both do, so a populated model dropdown means the credential was accepted. OpenRouter publishes its list openly, so there the dropdown says the endpoint answered and nothing about the key, which is first used when a run starts.

### Running out of room

**Time.** After its budget (Settings → Agent, 30 minutes by default) a run finishes the step it is on and asks whether to continue. Declining runs the **stand-down turn**: the transcript is replayed and one free-form closing turn runs with no tools. It writes no report. Every repository tool call extends the sandbox's own idle timer separately.

**Context.** Where the provider can summarise, NightWarden asks for that rather than letting the request be refused, and the transcript marks where it happened. Anthropic states support per model on its own catalog; OpenAI offers it on its reasoning models and publishes no flag, so that is what NightWarden reads. **When it summarises is the provider's own decision** - Anthropic is sent the edit with no trigger and applies its published default, and OpenAI, whose threshold is a required field, is given the window less the reply it must leave room for, which is the highest value that can ever fire. Where a model cannot summarise, the run stops and names the two things that work: start a new session, or pick a model with a larger window. OpenRouter is deliberately on that path, because it drops the middle of a conversation, and in an agentic transcript the middle is where the evidence lives.

---

## The record

### While the run works

The agent records each hypothesis as it settles it, one call per claim, append-only. They exist during the run so the queue can say what the agent currently believes, so the finish gate has something to inspect, so a citation is copied while its call is still in recent context, and so a run that dies before its write-up still renders something.

`record_hypothesis` refuses a claim citing an id that was never issued, which is one message rather than several: a handle exists only once its result does, so an id naming no answered call reads the same whether the model invented it or asked for the call in this same reply. A citation cannot be partially honoured either - a claim citing three ids where one is unknown is refused whole, rather than recorded on the two that survived and reading as a claim the model never made.

### The finish gate

A run may not end on an incomplete record. Two gaps are checked:

- **Empty record** - it recorded nothing at all.
- **Unaccounted calls** - reads answered since the last claim that nothing on the record speaks for.

Two rather than four, because a hypothesis is recorded already settled so none can be left open, and the recording tool refuses an unsupported claim so one cannot reach the record to be caught. The harness message names only the gaps that remain, so a model one claim short is not told about the four things it did do. It is capped, and the run composes anyway once the cap is reached: the status an unfinished record derives to is already honest. The cap belongs to the session rather than the run, counted from the requests already on the transcript, so resuming after an approval continues the allowance instead of opening a second one.

### The report turn

The final turn of an investigation. Every investigation tool is taken away and `SubmitInvestigationReport` is put back alone, with the hypotheses repeated in the request so the timeline copies call ids from nearby rather than from forty turns back. Whether the turn wrote is read from the tool's own answer, never from the record, which on a second run already holds a write-up this turn had no part in.

It runs in the same context as the investigation: the model has just done the work, and handing it a summary instead would cost the timestamps a timeline needs.

**The report timeline is not authored alone.** The agent writes the narrative entries; the system contributes a row for every released write, merged by time at render, so an action cannot be absent from a list the agent did not author in full.

**If the write-up fails**, the reason is on screen in plain words - the output limit, the context window, the time budget, or a model that declined - and the card offers **Try again**, which re-runs only the write-up against everything already found. The findings are never lost: a missing report costs the prose and nothing else.

### The report card

The door to the write-up, docked beside the chat input rather than drawn in the transcript: _building_, then _ready_, or _failed_ with a Try again. It is not a message. A message is fixed the moment it is sent and the report is not, so no position among the messages is right: written where it happened it goes stale, pushed last it sits underneath a later question. Docked, it is out of the ordering entirely, and it sits above a pending approval so the thing waiting on an answer stays nearest the input. Ready waits to be clicked, because a run ending must not move the page under whoever is reading it.

---

## Evidence sources

| Evidence                 | Needs            | Answers                                                                             |
| ------------------------ | ---------------- | ----------------------------------------------------------------------------------- |
| Containers and workloads | a runner         | State, config, image and digest, restarts, resource stats, events, processes        |
| Service logs             | a runner or Loki | What the service printed, windowed and filtered                                     |
| Metrics                  | a metrics source | An instant reading, a range around the alert, what rules exist, what metrics exist  |
| Host vitals              | a Docker runner  | CPU, memory, disk, network, kernel ring buffer, allowlisted host files              |
| Exceptions               | Sentry           | Stack traces, culprit and level, events and users affected, breakdown by any tag    |
| Releases                 | Sentry           | What shipped, when its deploy finished relative to the alert, and the commits in it |
| Changes                  | GitHub           | Merged pull requests and commits in a window                                        |
| The code                 | GitHub           | Read, edit, build and test inside a sandbox; open a draft pull request              |

A runner is optional. A metrics source, Loki or Sentry alone is a working install. `effectiveToolset` gates each library on its connection and reads it live, so disconnecting a source strips its tools mid-run and the model is told what it lost rather than calling into an absence.

### Absence is never evidence

**A result that shows less than the tool searched says so**: what was looked at, what was left out, and what the call cannot speak for. An empty list that cannot distinguish "nothing happened" from "we did not look there" is a defect, because the agent reads both as the first and stops. Where the gap cannot be closed the result states the limit rather than guessing past it. A wrong fact is worse than a stated unknown, and a stated unknown is itself a finding.

Five instances of that rule:

**Log windows.** Loki and Docker logs take `since` and `until`, so the agent can walk backwards through a noisy period. Kubernetes logs take only `since`, because the Kubernetes API has no end-time parameter at all, and the tool says where that limit comes from. When a result is capped it names the timestamp of its oldest line, which is the cursor for the next call.

**Log filtering.** `contains` keeps lines holding any of the given words; `excludes` drops them and is applied first. Both match plain text, case-insensitively, on whole lines - deliberately not regular expressions, because a pattern the model wrote, run over hundreds of thousands of lines on your server, is a risk the runner would be wearing on your behalf. **The tail is read before any filtering**, so the result carries how many lines were actually searched: two matches out of two hundred and two matches out of two hundred thousand are different findings.

**Expired Kubernetes events.** Kubernetes deletes events on a timer, commonly an hour, and does not report what that timer is. An empty event list can mean healthy or aged-out, so the result says which window was searched, how many events sit before it, and that a window past the common TTL may be asking for events that no longer exist. A deleted pod's events stay unattributable: an event carries no owner reference, and matching on name prefixes is a guess.

**An unreadable answer.** Every reply from a metrics source, Loki, Sentry or GitHub is parsed against the shape its vendor documents, in `integrations/`. A reply that does not match fails the call with the field named, because reading a response field by field turns any surprise into an empty list, and an empty list reaches the agent as "nothing happened". Unknown keys pass through, since an addition is the change these APIs actually make; a rename is what fails. Each parser requires only what its own reader reads, so a recovery check does not fail for a field only the listing uses.

**A partial read.** Prometheus, Thanos and Mimir answer with data _and_ a warning when part of a query could not be served. Every metrics result carries those warnings, including when the partial read returned nothing at all - a store being down and a healthy zero otherwise look identical. A native histogram is named as one, since its points hold an observation count rather than a measurement, and metric-name discovery states the window it searched, because VictoriaMetrics defaults those endpoints to the day so far where Prometheus defaults to all time.

### The control plane is invisible to its own agent

NightWarden is filtered out of every list the agent can reach - the manifest a runner advertises, the service list tool, and the resolver behind every targeted command - so it is never suggested, never addressable, and cannot be restarted mid-investigation. Identity is by container id, which a user cannot rename out from under it.

---

## Connecting integrations

Integrations are grouped by capability, not by vendor: **Alerting**, **Metrics**, **Logs**, **Error tracking**, **Fleet**, **Code**. A card is an adapter, not a vendor - where one client and a preset serve several products, that is one card with a picker.

**Every connection is probed with the exact calls an investigation makes before anything is saved**, so a successful connect is itself proof the address is reachable. A failed probe reports what went wrong - a name that would not resolve, a port with nothing listening, a timeout, an expired certificate - rather than a generic failure.

**A credential is issued by whoever verifies it.** NightWarden issues one for anything that pushes to it, because it hashes and matches the token on an unauthenticated request. The sender issues one for anything NightWarden pulls from, because NightWarden presents it. One `integrations` table holds both, and only an inbound row fills `token_hash`.

### Alerting

Two senders, either or both: **Prometheus Alertmanager** and **Grafana Alerting** (offered only because its notification engine is a fork of Alertmanager's). Each has its own credential and reports its own deliveries, so rotating one leaves the other alone.

The kind decides which card, which credential and which status line - **never how a body is parsed**, which is decided by the body's own shape (`{ alerts: [...] }`). A sender nobody has heard of therefore works with no code, which is why Mimir, Thanos and VictoriaMetrics need nothing of their own. The ingest endpoint accepts the token as `Authorization: Bearer` or `X-NightWarden-Token`, and never trusts a client-controlled header to identify the sender.

**The credential is shown once.** Only a hash is stored, so no screen and no endpoint can show it again. **Rotate** issues a new one and stops the old one immediately; **Disconnect** revokes it outright.

Leave `send_resolved` at its default and leave Grafana's **Disable resolved message** off: the resolved notification is one of the two ways an investigation learns the alert stopped firing. Leave Grafana's **Custom Payload** empty, because a custom body replaces the one NightWarden reads.

A card's status reflects delivery rather than configuration: "Waiting for first alert" until a webhook lands, then "Receiving".

### Metrics

Five cards - **Prometheus**, **VictoriaMetrics**, **Grafana Mimir**, **Thanos**, **Amazon Managed Prometheus** - each taking the base URL of the thing you already run. Grafana Cloud Metrics is hosted Mimir, so it connects through the Mimir card with your instance ID as username and an access policy token as password. AMP takes an AWS access key, secret key and region instead, because every request is signed with SigV4 rather than carrying a header.

**You connect exactly one.** Connecting one closes the other four until you disconnect it, and no tool call names a source. That is not a limit to work around: a Prometheus is scaled by putting Thanos or Mimir in front of it, so what you point NightWarden at is already the aggregate.

**The rules URL is separate from the query URL, and worth filling in.** It is the address NightWarden asks whether the rule that fired still holds. On Prometheus and Thanos it is the same URL. On VictoriaMetrics it is vmalert, a separate binary, because vmsingle and vmselect do not serve alerting rules at all. On Grafana Cloud it is your Grafana stack behind a service account token, which is also how a Grafana-managed alert rule is reached whatever you query for metrics. Left empty, queries still work but investigations opened by those alerts can never reach `resolved` on their own, and the card says so.

**What a source cannot answer, it says.** VictoriaMetrics serves metric metadata only from v1.130.0 and only with `-enableMetadata` set, so an empty answer there cannot tell an undeclared metric from a flag left off. Asking it what a metric measures states that condition rather than reporting the metric as undeclared, which would be a fact about the server dressed as a fact about your metric.

### Logs

The **Loki** card takes a base URL, and optionally a verbatim `Authorization` header value and an `X-Scope-OrgID` tenant, both stored encrypted. Three tools follow: log lines newest-first filtered in LogQL, log-derived metrics, and label discovery - the last because log labels are not a fixed convention, so the agent has to learn which ones select a service.

### Error tracking

The **Sentry** card takes a base URL (or `https://sentry.io`), an **organization slug** - the one in the address bar, not the display name - and an auth token. Every Sentry path is scoped by the organization, which is why the slug is part of the address rather than a filter.

The token needs **both `event:read` and `project:read`**: issues and events answer to the first, releases and commits to the second. They fail independently, so both are probed and a token holding one is refused at setup with the missing scope named.

Issue search windows on the alert. **The release list deliberately does not**, because a release that caused a slow failure can predate the alert by days; every release is stamped with how long before or after the alert its deploy finished, and none are filtered out. NightWarden never writes back: resolving or assigning an issue is a claim about the world that nothing re-checks.

### Fleet

Two paths, because a host and a cluster install differently: **Docker hosts** hands you a `docker run` line, **Kubernetes clusters** a `kubectl apply` manifest. Three steps either way:

1. **Name it** - the server name, unique, and the first segment of every target key this runner advertises.
2. **Install it** - NightWarden issues the token and shows the install command with it baked in. The runner dials back over WSS and appears within seconds.
3. **Confirm what it sees** - the advertised services with their full target keys, read from the manifest it already sent, so checking the wiring costs nothing and starts nothing.

An alert resolves to a service from the Compose labels and Kubernetes workload names your infrastructure already publishes, so there is nothing to label and nothing to keep in sync.

### Code

Connecting a GitHub repository lets investigations read the code, build and test a fix in an isolated checkout, and propose a draft pull request that a human reviews and merges. NightWarden never merges.

- **Docker and git must be on the API host.** Each code session runs in a hardened container built locally on top of `node:24`. Prerequisites are checked when you click Connect, not at 3am.
- **The token stays out of reach.** Fine-grained, exactly Contents and Pull requests (write) on one repository. Encrypted at rest, never returned by any endpoint, never entering the sandbox container, and never appearing in a URL or log: git runs host-side against the bind-mounted checkout and authenticates per invocation, so nothing lands in `.git/config`.
- **Container hardening:** read-only root filesystem (writable surfaces are exactly the checkout, the sandbox home and a bounded `/tmp`), all capabilities dropped, no-new-privileges, CPU and memory caps with swap pinned, a fork-bomb PID limit and an open-files limit, running as the API process's own non-root user. gVisor is used wherever the host provides it and can be required.
- **Egress is allowlisted** by default, through a shared filtering proxy built locally from Alpine's tinyproxy package. Out of the box that is the npm and yarn registries. A blocked host fails loudly and the agent is told to name any legitimately needed one in the PR. "None" gives no network; "Open" accepts that a prompt-injected agent could exfiltrate repository content.
- **Opening the PR is deliberately not approval-gated.** The PR is a draft proposal, and the repository's own CI and the human merge are the review layers; gating creation would stall the 3am flow this exists for. One session maps to one branch and at most one open PR, so calling the tool again updates it rather than opening a second.
- **Work survives every death mode.** One rule governs every way a sandbox ends: its work is committed and pushed to the session branch first, and if that push cannot be made the checkout is kept for the next boot to retry while the container stops regardless. At boot the API reaps orphaned containers and salvages orphaned workspaces before accepting sessions.

---

## Operations

**The state directory must be a host path mounted at the same path inside and out** - never a named volume. Code sandboxes run as sibling containers through the mounted Docker socket, and the host daemon resolves their workspace mounts against the host filesystem: a path that exists only inside the container does not error, it mounts an empty directory and every sandbox comes up with an empty checkout. The compose file derives both sides from one variable. NightWarden refuses to boot when its state directory is on the container's writable layer, since the database and keys would be discarded on the next restart.

**Both containers run as root, deliberately.** The API drives the mounted Docker socket, which is owned `root:docker` with a group id that differs on every host, so a fixed non-root user would fail on most machines. The runner reads host-owned files under its read-only `/rootfs` mount and processes under `--pid=host`. Dropping privileges would buy nothing: anything holding the Docker socket can start a privileged container, so it is already equivalent to host root. **Treat socket access as the trust boundary and give it only to hosts you would hand root on.**

**Externally visible URLs come from `NIGHTWARDEN_PUBLIC_URL`, not the request Host.** A runner dialling back and an Alertmanager posting a webhook need an address routable from their machines, which the Host header of an operator's browser is not.

**HTTPS.** Put a reverse proxy in front, point a domain at the host, set `NIGHTWARDEN_PUBLIC_URL=https://your-domain`, and drop the `ports` mapping so only the proxy is exposed. Without a domain, run plain HTTP behind a firewall.

**Backup.** Everything durable is in the state directory. Stop the stack, archive it, start again. Both key files are in there, and they fail apart: restoring without `secret.key` leaves stored credentials unreadable, and without `auth.key` everyone is signed out.

**Upgrade.** `docker compose pull && docker compose up -d`. Migrations apply on boot, each in a transaction, and the API refuses to start rather than serve a half-migrated schema.

**Tags.** Every push to `main` publishes, so `:latest` moves under you on the next pull. Each build is also tagged `sha-<short commit>`, which never moves - pin that if you want an upgrade to be a decision. Every image carries a signed provenance attestation verifiable with `gh attestation verify`.

**Architecture.** Published images are `linux/amd64`. `better-sqlite3` and `argon2` compile to native binaries that do not cross architectures, so on arm64 hosts build locally rather than pulling.

**Credential handling.** `secrets.ts` holds the whole rule. `issueToken` mints the two credentials NightWarden hands out, the runner token as `nwr_` and the alert ingest token as `nwi_`, each 32 random bytes; the prefix is the only self-description a loose token carries, which is what tells you which one to rotate. `hashToken` stores a SHA-256 of it and nothing else, so the plaintext is shown once and cannot be recovered. `tokenMatches` checks a presented token by scanning and comparing in constant time, never by looking the hash up on an index, because how long an index takes to answer is itself an answer. Tokens never appear in logs, identifiers or URLs.

Anything that must be replayed to a third party is encrypted rather than hashed, because it has to be presented again: provider API keys, the Prometheus and Loki `Authorization` headers, Loki's org id, the GitHub token, AMP keys. The owner password is neither - Better Auth stores it as an argon2id hash in the `account` row.

---

## Configuration

### API

| Variable                                      | Required | Description                                                                                                                                                                                                                      |
| --------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NIGHTWARDEN_PUBLIC_URL`                      | no       | The address other machines use to reach this install. Runners dial back here and Alertmanager posts here, so it must be routable from them. Unset means the request's own origin, which is fine locally and wrong behind a proxy |
| `NIGHTWARDEN_DIR`                             | no       | Absolute path to all durable state: `nightwarden.db`, the key files, sandbox `workspaces/`, generated `proxy/` config. Defaults to `~/.nightwarden`. Must be absolute                                                            |
| `NIGHTWARDEN_SECRET_KEY`                      | no       | AES-256-GCM key encrypting every credential stored at rest. Generated on first boot into a `0600` `secret.key` in `NIGHTWARDEN_DIR` if unset. Deleting it makes those credentials unrecoverable                                  |
| `NIGHTWARDEN_AUTH_SECRET`                     | no       | Signs session tokens. Generated on first boot into a `0600` `auth.key` in `NIGHTWARDEN_DIR` if unset. Deleting it signs everyone out and nothing else                                                                            |
| `PORT`                                        | no       | HTTP port (default `3000`)                                                                                                                                                                                                       |
| `HOST`                                        | no       | Bind address (default `127.0.0.1`)                                                                                                                                                                                               |
| `NIGHTWARDEN_LOG_LEVEL`                       | no       | Pino level (default `info`)                                                                                                                                                                                                      |
| `NIGHTWARDEN_FRONTEND_DIST`                   | no       | Directory holding the built frontend. The build embeds it beside the API bundle, so this is an override for an unusual layout, not something an install sets                                                                     |
| `NIGHTWARDEN_LLM_PROVIDER`                    | no       | `anthropic`, `openai` or `openrouter`. No default: leave unset and pick in Settings                                                                                                                                              |
| `<PROVIDER>_API_KEY`                          | no       | `ANTHROPIC_`, `OPENAI_` or `OPENROUTER_`. Seeds the database on first boot only, alongside the matching provider and model                                                                                                       |
| `<PROVIDER>_MODEL`                            | no       | Model id. No default: an unpicked model blocks investigations rather than guessing one                                                                                                                                           |
| `<PROVIDER>_BASE_URL`                         | no       | Override for a gateway or proxy                                                                                                                                                                                                  |
| `NIGHTWARDEN_DOCKER_RUNNER_IMAGE`             | no       | Image the Docker install command hands out                                                                                                                                                                                       |
| `NIGHTWARDEN_KUBERNETES_RUNNER_IMAGE`         | no       | Image the Kubernetes manifest hands out                                                                                                                                                                                          |
| `PROMETHEUS_URL`, `PROMETHEUS_AUTH_HEADER`    | no       | Seeds a metrics source on first boot only                                                                                                                                                                                        |
| `LOKI_URL`, `LOKI_AUTH_HEADER`, `LOKI_ORG_ID` | no       | Seeds Loki on first boot only, on the same terms                                                                                                                                                                                 |

**Seeding applies on first boot only.** A value whose slot the database already fills is ignored, so rotating a key in `.env` and restarting does nothing. Boot writes the row without dialling out, so a host that is down cannot stop the API from starting; the Integrations card reports what the connection is actually doing.

### Runners

| Variable                     | Required | Description                                                                                 |
| ---------------------------- | -------- | ------------------------------------------------------------------------------------------- |
| `NIGHTWARDEN_TOKEN`          | yes      | Runner credential issued from the frontend                                                  |
| `NIGHTWARDEN_WS_URL`         | yes      | API WebSocket endpoint, e.g. `wss://your-api/clients/connect`                               |
| `NIGHTWARDEN_HOST_PROC`      | no       | Docker runner only. `/proc` mount path inside a container (default `/proc`)                 |
| `NIGHTWARDEN_FILE_ALLOWLIST` | no       | Docker runner only. Colon-separated paths appended to the built-in `ReadHostFile` allowlist |
| `NIGHTWARDEN_LOG_LEVEL`      | no       | Pino level (default `info`)                                                                 |

**There is no variable naming the platform.** A runner is what it is because of which image was installed, and the token says the same thing; if the two disagree the API refuses the connection. Kubernetes access comes from the kubeconfig or in-cluster service account, so there is no Kubernetes-specific variable either. There is no variable to disable the approval gate.

---

## Development

Node.js 24 or newer, pnpm 11 or newer, and an Anthropic, OpenAI or OpenRouter API key.

```bash
git clone https://github.com/PrabhatMattoo/NightWarden.git
cd NightWarden
pnpm install
pnpm dev
```

That starts the API on port 3000 and the frontend on port 5173, both with live reload. To exercise the alert pipeline with no monitoring stack, POST an Alertmanager-format body to `/api/alerts/ingest`.

Four checks gate every change, and they are exactly what CI runs:

```bash
pnpm typecheck
pnpm test
pnpm format:check   # pnpm format fixes what it reports
pnpm build
```

`.github/workflows/verify.yml` holds the definition; `ci.yml` calls it on every pull request and `publish-images.yml` calls the same one before pushing an image, so a release can never clear a lower bar than a pull request.

**Tests live in `src/tests/` within each package** and are organised around behavioural seams rather than source modules: the highest public boundary that exercises the behaviour. A module reached only through a seam does not get its own file. Mocking happens only at system boundaries - external HTTP, WebSocket, time, randomness - never on our own modules.

**`@nightwarden/shared` has no build step.** It is consumed as TypeScript source through its `exports` map and inlined by esbuild at build time, so an edit is live immediately. `apps/api` and the two runners build with esbuild, which leaves every npm dependency external because native modules cannot be bundled - a line that is load-bearing for licence compliance as well, since each dependency's licence then travels in `node_modules`.
