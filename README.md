# NightWarden

[![CI](https://github.com/PrabhatMattoo/NightWarden/actions/workflows/ci.yml/badge.svg)](https://github.com/PrabhatMattoo/NightWarden/actions/workflows/ci.yml) ![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg) ![Node.js >= 24](https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg) ![pnpm >= 11](https://img.shields.io/badge/pnpm-%3E%3D11-orange.svg)

NightWarden is a self-hosted, source-available AI SRE agent for Docker and Kubernetes workloads. It watches your servers and clusters, and when something breaks it investigates the problem on its own, works out the smallest safe fix, and waits for you to approve it before touching anything.

## Why NightWarden

An alert fires at 3am. Normally that means waking up, SSHing into a box, reading logs, checking `docker ps` or `kubectl get pods`, correlating a recent deploy, and only then deciding what to do. The investigation is slow, manual, and always lands on a tired human.

NightWarden does that first pass for you. The moment an alert arrives it starts pulling logs, container or pod state, and host metrics, works out what caused the failure, and drafts a concrete fix - restarting a service, or, when the cause is in your code and a repository is connected, a draft pull request. It records what it finds as it goes and writes the whole thing up when it is done, so by the time you look at your screen the investigation is already written up: what it thinks broke, what it ruled out, the evidence behind each, and a fix waiting for one click.

The important part is what it will not do. NightWarden never changes anything on a server without your explicit approval. It reads freely and acts only on permission, so you get the speed of an automated responder with the safety of a human gate.

## How it works

```mermaid
flowchart LR
  subgraph stack["YOUR STACK"]
    direction TB
    alerting["<b>Alerting</b><br/>Alertmanager<br/>Grafana Alerting"]
    metrics["<b>Metrics</b><br/>Prometheus<br/>VictoriaMetrics<br/>Mimir · Thanos · AMP"]
    logs["<b>Logs</b><br/>Loki"]
    errors["<b>Error tracking</b><br/>Sentry"]
    code["<b>Code</b><br/>GitHub"]
  end

  api["<b>NightWarden API</b><br/>The only place an LLM runs<br/>Agent loop · Approval gate<br/>Evidence record · SQLite"]
  ui["<b>Frontend</b><br/>Report · Investigations<br/>Chat · Approval cards<br/>Fleet · Settings"]

  subgraph fleet["RUNNERS"]
    direction TB
    docker["Docker host"]
    k8s["Kubernetes cluster"]
  end

  alerting -- "POST /alerts/ingest" --> api
  metrics -- "reads on demand" --> api
  logs -- "reads on demand" --> api
  errors -- "reads on demand" --> api
  code -- "reads on demand" --> api
  api <-- "REST + SSE" --> ui
  docker -- "WSS, dialled out" --> api
  k8s -- "WSS, dialled out" --> api

  classDef box fill:#ffffff,stroke:#d1d9e0,color:#1f2328
  classDef apiBox fill:#dafbe1,stroke:#2da44e,color:#1f2328
  classDef uiBox fill:#f5edff,stroke:#8250df,color:#1f2328
  classDef runBox fill:#ddf4ff,stroke:#0969da,color:#1f2328
  class alerting,metrics,logs,errors,code box
  class api apiBox
  class ui uiBox
  class docker,k8s runBox
```

Your data stays on your machine: one SQLite file, no telemetry, and nothing forwarded on a schedule.

When an alert fires, your Alertmanager or Grafana Alerting posts it to the API's ingest endpoint. One webhook delivery is one alert group, and that grouping is yours: whatever `group_by` you already configured decides which alerts are investigated together, and NightWarden never regroups them on a clock of its own. The API opens a session for the group and runs the agent loop: it calls read-only tools on the relevant runner - service logs, process lists, metrics - feeds the results back to the model, and keeps going until the model proposes a fix or asks you a question.

**What the agent is handed about an alert** is everything the alert carried and nothing invented: its labels, its annotations, when it fired, and the service it resolves to when the fleet advertises one. It also gets the PromQL expression that fired, decoded out of the link Prometheus puts in the alert, so it knows the threshold without spending a call to find it, and the numbers the rule evaluated to at that instant where the sender reports them. Annotations are given as text and are never dereferenced - a `runbook_url` reaches the model as a fact, and nothing follows it, because fetching a URL out of an alert body is a request an attacker who can write an annotation would be choosing for you.

**And it can always tell NightWarden's own voice from everyone else's.** A model provider offers two roles, neither of them ours, so anything the harness says - that the record is still empty, that a tool has gone away, that the run is over and needs writing up - arrives in the same role a person's message does. NightWarden marks its own turns, and strips that mark from every source it did not write: what you type, what a question is answered with, what a tool returns, and what an alert carried. A log line on a monitored host, or an annotation on an alerting rule, therefore cannot speak as NightWarden - which is the only thing that makes the mark worth reading.

**It is also told why these alerts arrived together.** A delivery carries the labels your `group_by` resolved to, the labels every alert in the group holds, and any annotations they share. Your alert source has already worked that out, so the agent is given it rather than left to intersect the labels and guess whether what they share is the incident or a coincidence.

As it works it builds an **investigation record**, one claim at a time. Each time it settles a hunch it writes down what it tested, the verdict it earned and the ids of the tool calls that back it. Nothing it wrote earlier can be edited or deleted, so a claim it later abandoned stays on the record beside the one that replaced it. How well each claim is backed is worked out by the system from those citations, never claimed by the model.

When the run is over the agent is handed that record back with every investigation tool taken away and one left, and writes the report from it: a summary, a timeline, who was affected, and what you should do. Writing it last means it is written knowing how the investigation ended, and it can add only the prose the record has no room for, so what it says cannot outrun what the record holds.

The run cannot end on an empty record, or with reads nothing on the record speaks for: the agent is pushed back until both hold, and if it genuinely cannot work out the cause it says so instead of inventing one. A claim can only cite a call that has already answered, so nothing rests on a result the agent has not read.

**A fix is not believed until the alert says so.** NightWarden never asks the model whether its fix worked - it re-checks the condition that fired, and there are two independent ways it learns the answer:

1. **Your alert source tells it.** When your sender posts the resolved notification for an alert, that alert is marked cleared. This is the ordinary path and needs no configuration beyond a webhook receiver: Alertmanager's `send_resolved` is already the default, and Grafana sends one unless you turn it off.
2. **NightWarden asks the rules API itself.** For as long as an investigation has a condition nobody has seen recover, NightWarden asks whether the alerting rule that fired still holds an instance matching this alert. That is the same rule on the same evaluation interval that fired in the first place - not a query NightWarden composed, and not a threshold it guessed. Which address serves that API is something you tell it, because it is not always the one you query: VictoriaMetrics serves rules from vmalert alone, Grafana Cloud from your Grafana stack behind a different credential, and a Grafana-managed alert rule lives in Grafana rather than in any metrics source at all. A rule that is `pending` counts as still firing. It asks often while the incident is live and progressively less as it ages, because the realistic timeline is that a fix lands, the rule's `for:` duration elapses, and the alert goes quiet some minutes after the run that fixed it has already ended.

Both write the same record, so they cross-check each other: if you have turned `send_resolved` off, the second path still notices the recovery.

If nothing can answer - the source unreachable, the rule renamed, no rules endpoint configured - the investigation says the fix ran but recovery was never confirmed. It does not read "Resolved". An unanswerable question is never treated as a yes.

A run that had you approve a write and then goes quiet while the condition is still firing is pushed back and asked what you should do about it. It is never asked to try again: repeating a write that did not work is the exact mistake this catches.

**What a tool does and what you permit are two separate facts.** Every tool declares an _effect_ - whether the call reads or writes - and a _policy_ - whether it runs on its own or waits for you. Reads run freely so the agent can investigate without waking anyone. Writes pause the loop and show you an approval card, and nothing resumes until you approve, reject, or answer. The two are recorded apart on purpose: there is no separate list of gated actions that could fall out of step with the actions themselves, so the gate cannot be forgotten when a tool is added.

Asking you a question is not a tool. It is offered to the model as one, because tool-calling is the only channel it has to request anything, but it carries no implementation and no policy - it always suspends, and no setting can turn that off. A question offers at most four answers and always a free-text box beside them, so you are never boxed into a list; pick one by clicking it or by pressing its number.

**The two interruptions sit differently, because they stop different amounts.** An approval holds up one tool call, so its card stays inline in the transcript where it happened and you can scroll past it. A question holds up the whole run, so it pins above the message box until you answer. Either way, once it is settled it becomes an ordinary line in the transcript like any other call, with what you decided or what you said readable on it.

The agent is also told what an approved write did: a rejection comes back saying you refused and that nothing changed, so it redirects rather than trying the same call again. And when the same write has already run in this investigation, the approval card says how many times. Restarting a service a fifth time is a decision, not a mistake, so it is reported and never refused.

When a GitHub repository is connected and the cause is in your code, the same loop checks the code out into an isolated sandbox on the API host, builds and tests a fix there, and leaves a draft pull request for you to review.

### The three pieces

**API** is the brain, and the only place an LLM ever runs. It owns all durable state (a single SQLite file as the system of record, plus sandbox workspaces and generated proxy config in the same state directory), drives the agentic loop, gates every server write behind human approval, and talks to runners exclusively over an outbound-initiated WSS connection. When a GitHub repository is connected it is also the piece that provisions the per-session code sandbox - a hardened Docker container on its own host - and opens draft pull requests.

**Runner** is an executor you install on each host or cluster you want monitored, and it comes in two: a Docker runner and a Kubernetes runner. Which one you installed is what it is - it never probes for a platform, and one runner never serves both. It opens an outbound WSS connection to the API (so it works behind any firewall or NAT, with no inbound ports), advertises the services or workloads it can see, and executes the read and approval-gated write commands the API sends. It writes nothing to disk and remembers nothing across restarts. It is optional: a fully read-only investigation can run on your metrics, logs, and connected repository alone, and a runner adds container/host evidence and approved remediation when installed.

**Frontend** is the user UI, built around the report rather than the chat. The sidebar holds navigation and nothing else - Agent, Investigations, Integrations, then Settings and Log out - and collapses to a narrow icon strip when you want the full width for reading. Your conversations live behind a disclosure in the Agent page header; investigations have a page of their own, grouped by status. Open one from that list and the report takes the main area - the answer, what to do, what happened, what held up and what was ruled out, each claim showing what backs it and naming the calls it rests on - with the transcript in a rail on the right that also collapses. A plain conversation keeps the chat centred and shows no report. The runner fleet view and settings live here too.

**Watching a run end never moves the page under you.** While it works the chat has the whole stage, because a report being written in front of you is not worth reading. When the agent finishes, it posts its closing message and then a card: first that the report is being written, then that it is ready. Nothing changes until you click it. Arriving from the Investigations list is already a deliberate act, so that still opens the record directly.

**If the write-up does not happen, the page says so.** The likeliest cause is the model's own output limit - the report is the largest single thing it writes in a run - and there are three others: the context window, the time budget running out, and a model that simply declines. Whichever it was is on screen in plain words, and the card offers **Try again**, which re-runs only the write-up against everything the investigation already found. Asking for it in the chat does the same thing. The findings are never lost either way: they are recorded as the run goes, so a missing report costs you the prose and nothing else.

## The life of an investigation

Everything below is behaviour you can rely on. Where NightWarden cannot know something, it says so rather than guessing - that rule is the reason for most of the design here.

### One alert group, one investigation

Your alert source has already decided which alerts belong together. Alertmanager groups by the labels in your `group_by`, holds the group open for `group_wait`, and posts the whole group as a single webhook. NightWarden takes that grouping as given: **one delivery is one group is one investigation.**

It does not regroup on a timer of its own. Two alerts that your Alertmanager put in different groups become two investigations however close together they fire, because a wrong split costs duplicated work you can see, while a wrong merge writes one report about two incidents and stops either from resolving.

If you want more alerts investigated together, widen `group_by` in your `alertmanager.yml`. That is the only knob, and it is one you already understand.

This works the same for Grafana Alerting, Mimir, Thanos and VictoriaMetrics: all of them notify through Alertmanager or a fork of it, and all of them send the same grouping information.

### What is dropped, and what is not

An alert is a **duplicate** when some investigation already covers that exact alert and nothing has said the condition recovered. Alertmanager re-sends a still-firing alert on `repeat_interval` - as often as every few minutes - and every one of those repeats is dropped. Without that, a single incident would open a fresh investigation of the identical alert all day.

Two things are _not_ duplicates. An alert that cleared and later fires again carries a new start time, so it is a new incident and opens a new investigation. And a genuinely different alert in a group already being investigated joins that investigation rather than opening another - see below.

If your alert source leaves alerts out of a delivery, which Alertmanager does when a group is very large, it says how many. NightWarden passes that straight to the agent: _"the alert source left 6 further alerts out of this delivery, so this group is larger than what you can see here."_ An investigation working from a partial group is told it is working from a partial group.

### Waiting for a free slot

**Ten investigations run at once by default**, a setting under Settings → Agent. An investigation waiting on your approval still counts, because starting another one only puts a second write in front of the same person.

When every slot is busy, alerts **wait their turn**. They are never dropped - your alert source was already told the webhook was accepted, and it has nobody to retry to. The Investigations page shows a band saying how many are waiting, how many are running, and how long the oldest has waited. A slot frees when a run ends, and the alerts that have waited longest go first, as a whole group.

An alert that recovers while it is waiting is never investigated at all. There is nothing to look into, and no investigation is created to explain that.

Starting a chat when twenty are already running is refused rather than queued, because you are watching the screen when it happens: you get a message immediately instead of a spinner with no end in sight. Alerts never hit that wall - they wait their turn and nothing is dropped. The chat number is a runaway backstop rather than a usage limit; reaching it means something is very wrong.

### When another alert fires mid-investigation

If a new alert arrives for a group NightWarden is already investigating, it joins that investigation - even if the run is paused waiting for your approval. The agent is _told_ the alert fired. It is never asked whether the alert belongs, because your alert source already answered that.

The alert appears in the transcript at the point it interrupted, so you can read what the agent knew and when. It is also added to the investigation's alert list, which means the investigation cannot be called Resolved until that alert clears too.

An alert for any other group opens its own investigation, or waits for a slot.

### What a status means

| Status              | What it means                                  | What happens next                                                             |
| ------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------- |
| **Action required** | A run is frozen waiting on you, right now      | Approve it, answer it, or give it more time                                   |
| **Investigating**   | A run is working right now                     | Nothing to do                                                                 |
| **Resolved**        | Every alert on it stopped firing               | Nothing to do. This is the only status that means the incident is over        |
| **Completed**       | The run finished and nothing is blocked on you | Read what it found or ruled out, and act on its recommendation if it made one |
| **Stopped**         | You ended the run yourself                     | Nothing to do. Send it a message to pick it back up                           |
| **Failed**          | The run broke - usually the model provider     | Retried automatically if the cause was temporary; see below                   |

**Action required means something is frozen.** It is the group to open first, because a run in it is doing nothing until you answer. A finished investigation that recommends something is **Completed**, not Action required: nothing marks a recommendation as acted on, so a group that collected them could only ever grow until the words stopped meaning anything. The recommendation still reads on the row.

**Resolved is never inferred.** It does not mean a fix ran, and it never comes from the model saying it found the cause. It means the alert stopped firing, confirmed either by your alert source's resolved notification or by asking Prometheus whether its rule still holds. When nothing can answer, the record says recovery was not confirmed rather than claiming it.

Underneath, that status is the only state a session carries. A run working and a run parked on you each hold one of the ten slots, and nothing else does. This is what makes the count on the Investigations page true rather than an estimate, and what lets a restart tell a run that was alive from one that had finished.

### When NightWarden restarts

There is one process and one SQLite file, so a restart is the only way work is interrupted. Nothing is held in memory that matters: alerts are written to disk the moment they arrive, before anything decides whether there is a slot.

**Alerts still waiting** are still waiting. They start as soon as the API is back and a slot is free.

**A run that was working** is picked up. If its last exchange was cut in half, NightWarden repairs it where that is safe - a read can simply be run again - and unwinds past it where it is not, because a write it cannot prove the outcome of must never be replayed. If the alert is still firing and the run was recent, it carries on from its last complete exchange. Otherwise it is marked as interrupted, so it reads as broken rather than as an investigation that concluded nothing.

**A run parked on you** is left alone. It is waiting, not broken, and it keeps its slot. Whatever it is parked on comes back with the page: an approval, a question, or the check-in a long run makes when its time budget runs out.

There is one narrow case in between. If NightWarden stops in the instant between running an approved command and recording its result, it comes back knowing the command ran but not what it returned. It does not run it again - that is the one thing it must never do. The investigation stops with a note saying exactly that: _"whether the call took effect is unknown - check the target before approving it again."_

### Stopping, checking in, and running out of room

**You can stop a run.** The stop is checked between a turn's tool calls and the approval gate, so a run you stopped ends as stopped rather than parking an approval card nobody is going to answer. It also says so afterwards: the record reads **Stopped**, never Completed, because you ending a run and the agent running out of ideas are different things and only one of them is about the agent.

**A long run checks in rather than being killed.** After its time budget (Settings → Agent, thirty minutes by default) it finishes the step it is on and asks whether to continue. Say no and it writes up what it has rather than stopping mid-thought. Every repository tool call extends the sandbox's own idle timer, so a run doing real code work does not have its checkout swept from under it.

**A conversation can outgrow the model's context window.** Tool results are the bulk of it, and a long investigation eventually reaches the limit. What happens then depends on the model.

Where the provider can summarise - Anthropic models whose catalog says they support it - NightWarden asks for that instead of letting the request be refused. The model is handed a summary of the earlier part of the conversation and carries on, and the transcript marks where that happened. **Nothing leaves the record.** Every tool result is kept in full, so the report still quotes and charts evidence the model itself no longer holds, and every claim still cites the exact call behind it. The threshold is derived from the model's own published window, never a number NightWarden invented.

Where the provider cannot, the run stops and says so plainly, naming the two things that work: start a new session, or pick a model with a larger window under Settings → Provider. OpenRouter is deliberately left on that path: it truncates from the middle of a conversation rather than summarising, and in an agentic transcript the middle is where every piece of evidence lives.

### When a run fails

A failed run is retried **up to three times**, and only when the cause was worth waiting out: a dropped connection, a rate limit, a provider having a bad day. The retry rides the same schedule that checks whether the alert recovered, so it is minutes apart rather than seconds - the run already spent about a minute retrying inside itself before giving up.

It is never retried when trying again cannot work. A rejected API key, an empty account, or a model that no longer exists fails identically every time, and three more attempts would only write three more failures for you to read. Those stop and wait for you, and the message says which one it was.

A retry picks up from the last complete exchange, not from the beginning.

## What the agent can see

The agent works only through typed tools. Each one returns a structured result, and each result is kept in full so the report can quote it months later. What follows is what those tools reach, and where they stop - because a tool that quietly shows you less than it looked at is worse than one that finds nothing.

### The evidence it has

|                              | Needs            | What it answers                                                                     |
| ---------------------------- | ---------------- | ----------------------------------------------------------------------------------- |
| **Containers and workloads** | a runner         | State, config, image and digest, restarts, resource stats, events, processes        |
| **Service logs**             | a runner or Loki | What the service actually printed, windowed and filtered                            |
| **Metrics**                  | a metrics source | An instant reading, a range around the alert, what rules exist, what metrics exist  |
| **Host vitals**              | a Docker runner  | CPU, memory, disk, network, kernel ring buffer, allowlisted host files              |
| **Exceptions**               | Sentry           | Stack traces, culprit and level, events and users affected, breakdown by any tag    |
| **Releases**                 | Sentry           | What shipped, when its deploy finished relative to the alert, and the commits in it |
| **Changes**                  | GitHub           | Merged pull requests and commits in a window                                        |
| **The code**                 | GitHub           | Read, edit, build and test inside a sandbox; open a draft pull request              |

A runner is optional. A metrics source, Loki or Sentry alone is a working install - the agent investigates on whichever evidence it has, and simply has none of the rest to reach for. It is told which tools it has, so it never proposes one it lacks.

### Every result has a ceiling

A single tool result may occupy **30,000 characters**. Tools that can return a lot drop whole items to stay under it and say in the result what they left out and how to ask a narrower question.

A result still over the line after that is refused **whole**, and the agent is told to narrow the call and run it again. It is never truncated, because half a JSON result parses cleanly as a smaller truth - a list of three failing pods cut to two reads as two failing pods, and nothing about it looks wrong.

### Reading logs

**Windows.** Loki and Docker logs take `since` and `until`, so the agent can walk backwards through a noisy period rather than re-reading the newest lines forever. When a result is capped it names the timestamp of its oldest line, and that is the cursor for the next call.

Kubernetes logs take only `since`. The Kubernetes API has no end-time parameter at all, so the tool offers the window the platform can honour and says where the limit comes from.

**Filtering.** `contains` keeps lines holding any of the given words; `excludes` drops them, and is applied first so an excluded line never comes back. Both match **plain text, ignoring case, on whole lines** - deliberately not regular expressions, because a pattern the model wrote, run over hundreds of thousands of lines on your server, is a risk the runner would be wearing on your behalf.

**The tail is read before any filtering.** So the result carries how many lines were actually searched and whether it reached the end of what the engine holds. That matters: "two matches" out of two hundred lines searched and "two matches" out of two hundred thousand are different findings, and only one of them is evidence of anything.

### Where evidence expires

Kubernetes deletes events on a timer, commonly an hour, and does not report what that timer is set to. So an empty event list can mean the workload is healthy or it can mean the evidence aged out before anyone looked. The result says which window was searched, how many events sit before it, and that a window past the common TTL may be asking for events that no longer exist.

A deleted pod's events stay unattributable. An event carries no owner reference, and matching on name prefixes is a guess, so events belonging to a pod that has gone are left out rather than credited to a workload that may not own them.

### Absence is never treated as evidence

This is the rule the three sections above are instances of. A result that shows less than the tool searched has to say so: what was looked at, what was left out, and what the call cannot speak for. An empty list that cannot distinguish "nothing happened" from "we did not look there" is a defect, because the agent reads both as the first and stops.

Where the gap cannot be closed, the result states the limit rather than guessing past it. A wrong fact is worse than a stated unknown, and a stated unknown is itself a finding.

## Features

The sections above in one list, for scanning.

- **A report, not a wall of chat.** The agent records each claim as it settles it, then writes the report from that record once the run is over: a headline, a summary you can paste into a postmortem, a timeline that includes every write it was allowed to make, who was affected, and what to do next. What backs each claim is drawn beneath it from the recorded results - a chart of every series the query returned, the log lines that matched against how many were searched, the state a container was in, the diff of a change - so the report still renders long after your metrics retention has rolled over. Each claim quotes the exact tool call behind it and carries a grade the system worked out from those citations - backed by one source, by two independent ones, or confirmed by a check taken after a fix ran. If the write-up itself fails, the reason is on screen and one click runs it again.
- **It cannot finish without concluding.** A run is not allowed to end on an empty record, or on a claim backed only by a call that returned nothing, and no claim can be recorded at all without citing one. If it cannot find the cause it records what it ruled out and says so.
- **"Resolved" means the alert stopped firing.** Not that a fix ran, and never because the model said it found the cause. NightWarden confirms recovery against the condition that fired - your alert source's own resolved notification, or by asking the rules API whether its rule still holds. When nothing can answer, the record says recovery was not confirmed rather than claiming it.
- **One investigation per alert group.** Relatedness is your alert source's call, not a guess of ours: whatever `group_by` you already configured decides what is investigated together. Ten investigations run at once by default; beyond that alerts wait their turn and nothing is dropped. See [The life of an investigation](#the-life-of-an-investigation).
- **An investigation is a session with a condition attached, and only an alert carries one.** That condition is what gives the timeline an origin and lets recovery be re-checked against the world rather than asked of the model, so an investigation you started by hand could never be confirmed. Typing opens a chat, which answers the question and stops; an alert opens an investigation, which works it out and writes a report. Both get the full toolset behind the same approval gate, and a session is what it was created as and never changes underneath you.
- **Docker and Kubernetes, kept apart.** They are two runners, two images and two toolsets, not one runner with a switch. A Docker runner ships no Kubernetes client and a Kubernetes runner ships no Docker client, so the agent is offered Docker tools (`GetDockerLogs`, `RestartDockerService`, ...) on a host and Kubernetes tools (`GetK8sLogs`, `RestartK8sWorkload`, `GetK8sRolloutStatus`, ...) on a cluster, and a command sent to the wrong kind of runner has no handler to reach.
- **Invisible to its own agent.** NightWarden's control plane is filtered out of every list the agent can reach - the manifest a runner advertises, the service list tool, and the resolver behind every targeted command - so it is never suggested, never addressable, and cannot be restarted mid-investigation. Identity is by container id, which a user cannot rename out from under it.
- **Human-in-the-loop by default.** Write actions like `RestartDockerService`, `DockerBash`, `RestartK8sWorkload`, and `K8sBash` require explicit approval. Read actions run automatically so the agent can investigate without waiting on you.
- **Code fixes as draft pull requests.** Connect a GitHub repository and the agent can read the code, build and test a fix inside a hardened per-session Docker sandbox on the API host, and propose it as a draft pull request. A human always reviews and merges on GitHub - NightWarden never merges.
- **Durable suspend and resume.** A pending approval survives an API restart. You can approve hours later and the agent picks up exactly where it left off, because nothing is held in memory while it waits. A run that was working when the process died survives too: on the next boot the session says it was interrupted rather than quietly reading as an investigation that concluded nothing, and if the alert is still firing and the run was recent, it carries on from its last complete exchange.
- **A broken run tries again, but only when that can help.** A run that died on a dropped connection or a rate limit is retried up to three times, minutes apart. A run that died on a rejected key, an empty account or a model that no longer exists is not retried at all, because it would fail identically every time - it stops and tells you which one it was.
- **Works behind NAT.** Runners dial out to the API over WSS. There are no inbound ports to open on your servers.
- **Bring your own key.** Use Anthropic directly, or OpenRouter for everything else. Inference goes straight to your provider and your key never leaves your network.
- **Multi-runner.** One API coordinates as many runners as you have hosts and clusters, and a single investigation can span more than one. A fleet-level read with no runner named answers for every runner at once, each answer attributed.
- **No external infrastructure.** All durable state is one SQLite file in the state directory.
- **Bring your own monitoring.** Point your existing Prometheus, Loki, and Alertmanager or Grafana Alerting at the ingest endpoint. Anything that sends the Alertmanager envelope is accepted, which covers Mimir, Thanos and VictoriaMetrics too. Those same four are queryable as a metrics source - one client and a preset each, because they all speak the Prometheus API - and you connect exactly one of them: what you point at is already an aggregate, so a second connection is a mistake to refuse rather than a name to invent. Nothing to rip out - NightWarden plugs into the stack you already run.
- **A rules endpoint of its own.** Recovery is confirmed by asking whether the rule that fired still holds, and the address serving that is not always the one you query: vmalert on VictoriaMetrics, your Grafana stack on Grafana Cloud, a separate ruler on a microservices Mimir. Each connection names its own, with its own credential, so recovery verification works on the products people actually deploy rather than only on single-binary Prometheus.

## Install

NightWarden ships as one image: the API and the frontend on a single origin, with SQLite as the system of record. One container on one Linux host with Docker, and no database alongside it.

```bash
curl -O https://raw.githubusercontent.com/PrabhatMattoo/NightWarden/main/docker-compose.yml
export NIGHTWARDEN_PUBLIC_URL=http://203.0.113.10:3000   # routable from your servers, not localhost
docker compose up -d
```

`NIGHTWARDEN_PUBLIC_URL` is the only variable you must set. It is the address runners dial back to and Alertmanager posts to, so a browser's `localhost` is not it. Everything else has a default and is listed under [Configuration](#configuration).

Open that address, create the owner account, then go to **Settings → Provider**: choose Anthropic or OpenRouter, paste a key, press **Test connection**, and pick a model. Until that is done NightWarden refuses to start investigations rather than failing at the first alert.

To run from source instead, see [Development](#development).

## Connect your stack

In the frontend go to **Integrations**, where each card is grouped by what it gives an investigation: **Alerting** (where your alerts come from), **Metrics**, **Logs**, **Error tracking**, **Fleet** (executors on your hosts), and **Code**. None is strictly required to start a chat; investigations need an alert source plus at least one evidence source (a runner, a metrics source, Loki, or Sentry).

**Add a runner.** Two paths, because a host and a cluster install differently: **Docker hosts** hands you a `docker run` line, **Kubernetes clusters** a `kubectl apply` manifest. Either wizard is three steps and needs no manual config editing:

1. **Name it** - the server name NightWarden addresses this host or cluster by, and the first part of every service address it reports. It must be unique, and the services beneath it are identified by what your infrastructure already publishes.
2. **Install the runner** - NightWarden mints a runner token and shows a ready-to-run install command with the token baked in. Copy it and run it on the target host or cluster. The runner dials back out over WSS and appears in your fleet within seconds.
3. **Confirm what it sees** - the runner's advertised services, with the full identity key each one resolves under. Read straight from the manifest it already sent, so checking the wiring costs nothing and starts nothing.

**Wire your alerts.** NightWarden does not ship a monitoring stack - forward alerts from the one you already run. Two senders are offered under **Alerting**, and you can connect either or both:

- **Prometheus Alertmanager** hands you the ingest URL, the credential, and a receiver block to paste into your `alertmanager.yml`. The block carries a placeholder where the credential goes rather than the credential itself, so it is safe to paste into a ticket or a config repo. Leave `send_resolved` at its default of true: the resolved notification is one of the two ways an investigation learns the alert stopped firing.
- **Grafana Alerting** hands you the URL and credential for a Webhook contact point. Leave **Custom Payload** empty - a custom body replaces the one NightWarden reads - and leave **Disable resolved message** off, for the same reason as `send_resolved`.

Each mints its own credential and reports its own deliveries, so rotating one leaves the other alone. The card's status reflects delivery rather than configuration - "Waiting for first alert" until a webhook actually lands, then "Receiving". A credential covers the whole fleet and is never per runner.

**The credential is shown once.** NightWarden stores only a hash of it, so no screen and no endpoint can show it again - copy it when it is generated. Lose it and **Rotate** issues a new one, which stops the old one working the moment it is created. **Disconnect** revokes it outright and refuses further deliveries.

That is the whole setup: an alert resolves to a service from the Compose labels and Kubernetes workload names your infrastructure already publishes, so there is nothing to label and nothing to keep in sync. The ingest endpoint accepts the token via either an `Authorization: Bearer` header or an `X-NightWarden-Token` header, and recognizes a delivery by the shape of its body (`{ alerts: [...] }`) rather than by any client-controlled header. Anything that produces that envelope is accepted, which is why Mimir, Thanos and VictoriaMetrics need nothing of their own - they all notify through Alertmanager or a fork of it. You can also start an investigation at any time from the frontend chat, with no alert source at all.

**Connect your metrics.** Five cards under **Metrics** - **Prometheus**, **VictoriaMetrics**, **Grafana Mimir**, **Thanos** and **Amazon Managed Prometheus (AMP)** - each take the base URL of the thing you already run. You connect one of the five. Grafana Cloud Metrics is hosted Mimir, so it connects through the Mimir card with your instance ID as the username and an access policy token as the password. AMP takes an AWS access key, secret key and region instead of a URL credential - every request is signed with SigV4 rather than carrying a header. NightWarden only ever reads: the agent gains an instant lookup and a range query windowed around the alert, so it can tell whether a metric climbed for hours or spiked at deploy time, with zero runners installed. Both addresses are probed with the exact calls an investigation makes before anything is saved, so a successful connect is itself the proof they are reachable. Keep them off the public internet; NightWarden needs to reach them over your private network.

**The card asks for a rules URL as well as a query URL**, and it is worth filling in. It is the address NightWarden asks whether the rule that fired still holds, which is one of the two ways an investigation learns the alert stopped firing. On Prometheus and Thanos it is the same URL as the query one. On VictoriaMetrics it is vmalert, a separate binary, because vmsingle and vmselect do not serve alerting rules at all. On Grafana Cloud it is your Grafana stack, behind a service account token rather than the metrics credential - and that is also how a Grafana-managed alert rule is reached, whatever you query for metrics. On AMP this path is unverified against a live workspace; if it doesn't work, leave it empty. Leave it empty and the connection still works for queries, but investigations opened by its alerts can never reach Resolved on their own; the card says so.

**One metrics source, whichever product it is.** Connecting one closes the other four cards until you disconnect it, and no tool call ever names a source. That is not a limit you work around by adding a second: a Prometheus is scaled by putting Thanos or Mimir in front of it, and what you point NightWarden at is already the aggregate.

**What a source cannot answer, it says.** VictoriaMetrics does not implement the metric metadata API - it returns an empty result for every metric that has ever existed - so asking it what a metric measures reports that limitation rather than reporting the metric as undeclared, which would be a fact about VictoriaMetrics dressed as a fact about your metric.

**Reachable from where.** Both evidence URLs are dialled by the API, from its own machine, so an address that works in your browser is not the test. The two cases that catch people out: containerized, `localhost` means the API's own container, not the host it runs on - use `host.docker.internal:9090` for a service beside it on the same host (the shipped compose file maps that name on Linux, where Docker does not provide it). On a separate host, use an address routable on your private network. A failed probe reports what actually went wrong - a name that would not resolve, a port with nothing listening, a timeout, an expired certificate - rather than a generic failure, so the fix is usually in the message.

**Connect Loki.** The **Loki** card takes the base URL of the Loki you already run (and, only if yours needs them, a verbatim `Authorization` header value and a tenant `X-Scope-OrgID` for multi-tenant Loki - both optional, the header stored encrypted). NightWarden only ever reads: the agent gains three log tools - one for log lines (newest first, filtered in LogQL), one for log-derived metrics (rate/count over logs), and a label-discovery tool it uses to learn which labels select a service's logs, since log labels are not a fixed convention. All three window on the alert. The connection is probed against the labels endpoint before it saves, so a successful connect is itself the proof it is reachable. Loki alone is a sufficient evidence source, so a logs-first fleet with no metrics can still be investigated. Keep Loki off the public internet; NightWarden needs to reach it over your private network.

**Connect Sentry.** The **Sentry** card takes three things: the base URL of the Sentry you run (or `https://sentry.io`), your **organization slug** - the one in the address bar when you browse Sentry, not its display name - and an auth token. Create the token in Sentry under Settings then Developer Settings as an internal integration, which self-hosted supports, and grant it **both `event:read` and `project:read`**: issues and events answer to the first, releases and commits to the second. Both are probed before anything is saved, so a token holding only one is refused at setup with the missing scope named rather than answering half the questions at 3am. The token is stored encrypted and never returned by any endpoint.

NightWarden only ever reads, and never writes back: nothing is resolved, assigned or commented on, because an issue's triage state belongs to whoever owns that workflow. The agent gains five tools - search the issues around the alert, read one issue's latest event in full with its stack trace, break an issue down by a tag such as `server_name` to tell one host from the whole fleet, list releases, and list the commits in a release. Issue search windows on the alert; the release list deliberately does not, because a release that caused a slow failure can predate the alert by days, so every release is stamped with how long before or after the alert its deploy finished and none are filtered out. Where Sentry has a repository integration, the commits carry its own suspect-commit marker and the pull request.

## Running it

What an install needs you to know once it is up.

**The state directory must be a host path mounted at the same path inside and out** - never a named volume. Code sandboxes run as sibling containers started through the mounted Docker socket, and the host's daemon resolves their workspace mounts against the host filesystem: a path that exists only inside the container does not error, it mounts an empty directory and every sandbox comes up with an empty checkout. The compose file derives both sides from one variable so they cannot drift; if you move the path, keep the mapping symmetrical. NightWarden also refuses to boot when its state directory is on the container's writable layer, since the database and secret key would be discarded on the next restart.

**Both containers run as root, deliberately.** The API drives the mounted Docker socket to start sandbox containers, and that socket is owned `root:docker` with a group id that differs on every host, so a fixed non-root user would fail on most machines. The runner reads host-owned files under its read-only `/rootfs` mount and processes under `--pid=host`, neither of which an unprivileged uid can see. Dropping privileges would also buy nothing: anything holding the Docker socket can start a privileged container, so it is already equivalent to host root. Treat socket access as the trust boundary and give it only to hosts you would hand root on.

**HTTPS.** Put Caddy (or any reverse proxy) in front, point a domain at the host, set `NIGHTWARDEN_PUBLIC_URL=https://your-domain`, and drop the `ports` mapping so only the proxy is exposed. Without a domain, run plain HTTP and restrict the port with your firewall.

**Backup.** Everything durable is in the state directory. Stop the stack, `tar czf backup.tar.gz -C /opt nightwarden`, start it again. `secret.key` is in there: restoring the database without it leaves the stored API keys unreadable and signs every user out.

**Upgrade.** `docker compose pull && docker compose up -d`. Schema changes are applied on boot: the API runs any migration your database has not seen yet, each one inside a transaction, and refuses to start rather than serve a half-migrated schema. Nothing to run by hand, and your data survives the upgrade.

**Tags.** Every push to `main` publishes, so `:latest` tracks `main` and moves under you on the next pull. Each build is also tagged `sha-<short commit>`, which never moves: pin that in the compose file and in `NIGHTWARDEN_DOCKER_RUNNER_IMAGE` / `NIGHTWARDEN_KUBERNETES_RUNNER_IMAGE` if you want an upgrade to be a decision rather than a side effect of restarting. Every image carries a signed provenance attestation naming the commit and workflow that built it, verifiable with `gh attestation verify`.

**Architecture.** The published images are `linux/amd64`, which is what a standard cloud VM runs. `better-sqlite3` and `argon2` compile to native binaries that do not cross architectures, so on arm64 hosts - Apple Silicon, Graviton, Ampere - build locally rather than pulling.

**Building the images yourself.** `docker compose build` for the control plane, `docker build -f apps/runners/docker/Dockerfile -t nightwarden-docker-runner .` and `docker build -f apps/runners/kubernetes/Dockerfile -t nightwarden-kubernetes-runner .` for the two runners. Both build natively for whatever machine you are on; add `--platform linux/amd64` on an Apple Silicon Mac when the image is destined for an x86 host.

## Configuration

### API (`apps/api/.env`)

| Variable                              | Required | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NIGHTWARDEN_LLM_PROVIDER`            | no       | `anthropic` or `openrouter`. There is no default: leave it unset and pick a provider in frontend Settings instead.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `ANTHROPIC_API_KEY`                   | no       | Anthropic API key. Seeds the database on first boot only, alongside `NIGHTWARDEN_LLM_PROVIDER=anthropic` and `ANTHROPIC_MODEL`.                                                                                                                                                                                                                                                                                                                                                                                                          |
| `OPENROUTER_API_KEY`                  | no       | OpenRouter API key. Seeds the database on first boot only, alongside `NIGHTWARDEN_LLM_PROVIDER=openrouter` and `OPENROUTER_MODEL`.                                                                                                                                                                                                                                                                                                                                                                                                       |
| `OPENROUTER_BASE_URL`                 | no       | Base URL for OpenRouter. Unset means `openrouter.ai/api/v1`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `ANTHROPIC_BASE_URL`                  | no       | Base URL for an Anthropic-compatible gateway or proxy. Unset means `api.anthropic.com`.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `ANTHROPIC_MODEL`                     | no       | Model id for the Anthropic provider. No default: an unpicked model blocks investigations rather than guessing one.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `OPENROUTER_MODEL`                    | no       | Model id for the OpenRouter provider. No default, as above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `NIGHTWARDEN_PUBLIC_URL`              | no       | The address other machines use to reach this install, e.g. `https://nightwarden.example.com`. Runners dial back here and Alertmanager posts here, so it must be routable from them. Unset means the request's own origin, which is fine for local development and wrong behind a proxy.                                                                                                                                                                                                                                                  |
| `PORT`                                | no       | HTTP port the API listens on (default: `3000`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `HOST`                                | no       | Bind address (default: `127.0.0.1`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `NIGHTWARDEN_DIR`                     | no       | Absolute path to the directory holding all durable state: `nightwarden.db`, `secret.key`, the per-session GitHub sandbox `workspaces/`, and the generated egress-proxy config `proxy/`. Defaults to `~/.nightwarden`; created on boot if missing. Must be absolute (a relative value fails at boot); on a Mac keep it under your home so Docker Desktop's file sharing covers the sandbox mounts.                                                                                                                                        |
| `NIGHTWARDEN_SECRET_KEY`              | no       | AES-256-GCM key that signs owner sessions and encrypts every credential stored at rest: provider API keys, integration tokens, and the fleet ingest token. If unset, the API generates one on first boot and writes it to a `0600` `secret.key` file in `NIGHTWARDEN_DIR`, then reuses it on every restart. Deleting that file is the same as rotating the key: it invalidates every owner session and makes those credentials unrecoverable, so each reads back as unset. Set this explicitly if you want to manage the value yourself. |
| `NIGHTWARDEN_LOG_LEVEL`               | no       | Pino log level for the API process, e.g. `debug`, `info`, `warn`, `error` (default: `info`).                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `NIGHTWARDEN_FRONTEND_DIST`           | no       | Directory holding the built frontend. The build embeds it beside the API bundle and that is where the API looks, so this is an override for running the bundle from an unusual layout, not something an install sets. With no build there and `NODE_ENV=production`, the API refuses to boot rather than serving an API that 404s every browser.                                                                                                                                                                                         |
| `NIGHTWARDEN_DOCKER_RUNNER_IMAGE`     | no       | Image the frontend's Docker-host install command hands out. Defaults to `ghcr.io/prabhatmattoo/nightwarden-docker-runner:latest`; override it to pin a tag or to serve the image from a private registry.                                                                                                                                                                                                                                                                                                                                |
| `NIGHTWARDEN_KUBERNETES_RUNNER_IMAGE` | no       | Image the frontend's Kubernetes manifest hands out. Defaults to `ghcr.io/prabhatmattoo/nightwarden-kubernetes-runner:latest`.                                                                                                                                                                                                                                                                                                                                                                                                            |
| `PROMETHEUS_URL`                      | no       | Seeds a Prometheus metrics source on first boot only, so a fresh install comes up configured without opening a browser. Probed before it saves; an address that does not answer is logged and left unconfigured. Prometheus serves its own rules, so the seeded source uses this address for both.                                                                                                                                                                                                                                       |
| `PROMETHEUS_AUTH_HEADER`              | no       | Verbatim `Authorization` header value for the above, stored encrypted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `LOKI_URL`                            | no       | Seeds the Loki integration on first boot only, on the same terms as `PROMETHEUS_URL`.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `LOKI_AUTH_HEADER`                    | no       | Verbatim `Authorization` header value for Loki, stored encrypted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `LOKI_ORG_ID`                         | no       | `X-Scope-OrgID` tenant header for a multi-tenant Loki.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

### GitHub integration

Connecting a repository (frontend → Integrations) lets investigations read the code, build and test a fix in an isolated checkout, and propose it as a draft pull request that a human reviews and merges on GitHub - NightWarden never merges. Requirements and properties:

- **Docker and git must be installed on the API host** - each code session runs in a hardened container there, from a `nightwarden-sandbox` image built locally on top of `node:24` (rebuilt automatically whenever its definition changes). Prerequisites are checked when you click Connect, not at 3am. If the API itself runs in a container it needs the Docker socket mounted.
- **The token stays out of reach.** The connect page deep-links to a fine-grained token with exactly Contents and Pull requests (write) on the one repository and a 90-day expiry; the frontend shows the remaining days and warns as it nears, and organizations that block fine-grained tokens can use a classic PAT instead. The token is encrypted at rest, never returned by any endpoint, never enters the sandbox container, and never appears in any URL or log: git runs host-side against the bind-mounted checkout and authenticates per invocation, so nothing lands in `.git/config`. Disconnecting tears down live sandboxes first, then deletes NightWarden's stored copy - full invalidation means revoking the token on GitHub.
- **Container hardening**: read-only root filesystem (the writable surfaces are exactly the checkout, the sandbox home, and a bounded `/tmp`), all Linux capabilities dropped, no-new-privileges, real CPU/memory caps (swap pinned so the memory limit can't be doubled; both are Settings knobs), a fork-bomb PID limit and an open-files limit, and the sandbox runs as the API process's own non-root user - the API warns at boot when it runs as root, because its sandboxes then do too. gVisor (`runsc`) is used automatically wherever the Docker host provides it; the sandbox settings can require it. The worst code outcome under injection is a commit on a `nightwarden/*` branch inside a draft PR behind GitHub's human merge gate.
- **Egress is allowlisted** (Settings → Sandbox, default). All sandbox traffic is forced through a shared filtering proxy - built locally from Alpine's own tinyproxy package, so no third-party proxy image enters the supply chain - that only reaches the allowlisted hosts, out of the box the npm and yarn registries. The agent installs what it needs itself (dependencies, global CLI tools into its writable home); a blocked host fails loudly, and the agent is instructed to name any legitimately needed one in the PR so you can extend the list. Container loopback is untouched, so the repo's own local test servers still work. The other two modes: "None" gives the container no network at all (dependency installs are skipped), "Open" keeps the default Docker bridge attached - accepting that a prompt-injected agent could then exfiltrate repository content.
- **Provisioning is deterministic and visible.** A session's sandbox clones the repo onto that session's own `nightwarden/*` branch (a resumed session finds its branch on the remote and continues it) and, when the repo pins `packageManager` or has a Node lockfile, installs dependencies up front - a pinned pnpm or yarn runs through corepack at its exact pinned version. Each stage (cloning, starting, installing) streams live to the frontend transcript. A failed install is survivable - read, edit, and PR keep working - and its output tail reaches the logs and the agent, which is told to fix or work around it before building or testing.
- **Opening the PR is deliberately not approval-gated.** The PR is a draft proposal; the repository's own CI and the human merge are the review layers, and gating creation would stall the very 3am flow this exists for. The agent is instructed to verify with the repo's own build and tests first and state in the PR body what it ran; NightWarden appends the incident context, the changed files, and a session reference. One session maps to one branch and at most one open PR - calling the tool again pushes the newest commits and updates it, which is also what makes a retry after a crash update the proposal rather than open a second one. (Repos whose GitHub plan lacks draft PRs get a normal PR, and the tool result says so.)
- **Work survives every death mode.** Files must be read before they can be edited, and edits come back as real diffs in the transcript. One rule governs every way a sandbox ends: its work is committed and pushed to the session branch first, and if that push cannot be made the checkout is kept for the next boot to retry while the container is stopped regardless. A container outliving its session is waste; the work is not replaceable. That covers the sandbox idling out (default one hour, a Settings knob, alongside the session time budget every repo tool call extends), the API shutting down, the repository being disconnected, and you deleting the session. At boot the API reaps orphaned containers and salvages orphaned workspaces the same way, before accepting sessions, so even a crash mid-edit leaves the work on its branch rather than gone.
- We recommend enabling branch protection on the repository's default branch (GitHub → Settings → Branches); NightWarden's token deliberately has no Administration permission and cannot do this for you.

### Runners (`apps/runners/docker/.env`, `apps/runners/kubernetes/.env`)

| Variable                     | Required | Description                                                                                               |
| ---------------------------- | -------- | --------------------------------------------------------------------------------------------------------- |
| `NIGHTWARDEN_TOKEN`          | yes      | Runner credential minted from the frontend                                                                |
| `NIGHTWARDEN_WS_URL`         | yes      | API WebSocket endpoint, e.g. `wss://your-api/clients/connect`                                             |
| `NIGHTWARDEN_HOST_PROC`      | no       | Docker runner only. `/proc` mount path when running inside a container (default: `/proc`)                 |
| `NIGHTWARDEN_FILE_ALLOWLIST` | no       | Docker runner only. Colon-separated paths appended to the built-in allowlist for the `ReadHostFile` tool. |
| `NIGHTWARDEN_LOG_LEVEL`      | no       | Pino log level for the runner process (default: `info`).                                                  |

There is no variable naming the platform. A runner is a Docker runner or a Kubernetes runner because of which image you installed, and the token you installed it with says the same thing; if the two disagree the API refuses the connection and says so. Kubernetes access comes from the runner's kubeconfig or in-cluster service account (via `@kubernetes/client-node`), so there is no Kubernetes-specific env var either. A runner's server name is set when you add it in the frontend, never on the runner itself: it is the first segment of every target key that runner advertises. Write tools like `RestartDockerService`/`DockerBash` are always offered and always gated: a write suspends the investigation for human approval, so there is no mode to configure and no env var to set.

## Development

To run from source you need Node.js 24 or newer, pnpm 11 or newer, and an Anthropic or OpenRouter API key.

```bash
git clone https://github.com/PrabhatMattoo/NightWarden.git
cd NightWarden
pnpm install
pnpm dev
```

That starts the API on port 3000 and the frontend on port 5173, both with live reload. Open `http://localhost:5173` and set an owner password on first visit.

To exercise the alert pipeline without a monitoring stack, POST an Alertmanager-format body to the API's `/api/alerts/ingest` endpoint, which drives an investigation end to end on your machine.

Four checks gate every change, and they are exactly what CI runs:

```bash
pnpm typecheck
pnpm test
pnpm format:check   # pnpm format fixes what it reports
pnpm build
```

`.github/workflows/verify.yml` holds the definition; `ci.yml` calls it on every pull request and `publish-images.yml` calls the same one before it pushes an image, so a release can never clear a lower bar than a pull request.

## License

NightWarden is open source under the [GNU Affero General Public License v3.0](LICENSE). Run it on your own infrastructure, for any purpose, free and without limits. If you run a modified version as a network service, the AGPL requires you to offer its source to that service's users.

NightWarden's terms cover NightWarden. Its dependencies stay under the licences their own authors granted: every image carries `LICENSE` and `NOTICE` at its root, and the licence text of everything bundled into the frontend is served at `/THIRD-PARTY-LICENSES.txt`.

For commercial or proprietary use outside the terms of the AGPL, contact the maintainers about a separate licence.
