# Changelog

NightWarden has not had a public release. Every version below `1.0.0` is a
prelaunch development build and carries no stability guarantee: the API, the
runner protocol and the database schema all changed freely across them.

`1.0.0` will be the first public stable release.

The minor number marks a change of shape, not a feature. Three of them have
happened so far, and everything between two of them is a patch.

## 0.3.x - platform-aware runners

From `0.3.0`, 2026-07-31, "a runner declares its platform at onboarding".

One runner serves exactly one platform, decided when its token is minted rather
than discovered at runtime, so routing and the offered toolset read the row
instead of asking the fleet. Two apps produce two images: a Docker runner
carries no Kubernetes client and a Kubernetes runner carries no dockerode.
Alert ingest resolves against the live fleet or rejects loudly. Investigations
gained an evidence record, a Prometheus-compatible metrics integration and a
sandbox with deny-by-default egress.

## 0.2.x - the monorepo

From `0.2.0`, 2026-06-03, "harness setup and Phase 1 monorepo scaffold".

The single application became a pnpm workspace: an API that owns the SQLite
system of record, a console, a runner and shared packages. The agent loop, the
approval gate, the tool registry and secret redaction all landed here, as did
the split between what a tool does (`effect`) and what the operator permits
(`policy`).

## 0.1.x - prototype

From `0.1.0`, 2026-02-08.

The original Nightwatch prototype, alongside the Clipper video-processing demo
that later became Encodr and moved to its own repository.
