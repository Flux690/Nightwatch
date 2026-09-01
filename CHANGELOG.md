# Changelog

Every notable change to NightWarden, newest first. The format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versioning is [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

An entry says what a user can now do differently. A change nobody outside this repository can notice does not go in, which is what keeps this from becoming a second copy of the commit log.

Each entry closes with the version it shipped in and the commit that made it, so the reasoning behind a line is one `git show` away.

NightWarden has not had a public release. Everything below `1.0.0` is a prelaunch development build: the API, the runner protocol and the database schema all change freely, and `1.0.0` will be the first public stable release.

## [Unreleased]

### Added

- **Sentry, as an evidence source.** Connect it under Integrations with a base URL, your organization slug and an auth token carrying `event:read` and `project:read`; both scopes are probed before the connection is saved, so a token missing one is refused with the scope named rather than failing mid-incident. Investigations gain five read-only tools: search the issues around the alert, read one issue's latest event with its stack trace, break an issue down by a tag such as `server_name`, list releases with how long before or after the alert each was deployed, and list the commits in a release with the pull request and Sentry's suspect-commit marker. Self-hosted Sentry and sentry.io both work. Nothing is written back to Sentry. — `0.4.0`

- **Upgrading no longer deletes your database.** Schema changes now ship as migrations the API applies on boot, each in its own transaction, and it refuses to start rather than serve a half-migrated schema. Nothing to run by hand. — `0.3.174` (`c306689`)

- **The API image now carries the licence text of every package bundled into the frontend**, served at `/THIRD-PARTY-LICENSES.txt` and written at build time from what Vite actually bundles. Vite inlines those packages into the browser assets, so unlike an installed dependency their own licence files never reached the image. The README's License section now names where every set of terms lives. — `0.3.173` (`f9923f8`)

### Changed

- **The session list requires a `kind`.** `GET /api/sessions` now answers 400 without `?kind=investigation` or `?kind=chat`. The unfiltered shape no index could serve, and nothing asked for it; every page in the frontend already sent one. — `0.3.174` (`c306689`)

- **One metrics source, not one per product.** Connecting Prometheus now closes the VictoriaMetrics, Mimir, Thanos and AMP cards until you disconnect it, and the agent no longer names a source on any metrics call. What you point at is already an aggregate, so the second connection was a setting that could only ever disagree with itself. — `0.3.172` (`9cc8481`)
- **Docker and Kubernetes logs carry a timestamp on every line**, the one the engine recorded, so a log line can be placed against the moment the alert fired. `contains` and `excludes` now match the message alone rather than the timestamp beside it. — `0.3.171` (`f49f9c8`)
- **A runner no longer carries a separate label.** The column was left over from when the wizard's field was a cosmetic display name; nothing has written to it since that field became the server name. — `0.3.169` (`fcb134e`)
- **A runner's name is required, and it is the server name.** The add-runner wizard called it "Display name (optional)" and it was never either: it is the first segment of every service address the agent copies, and the column is unique. An empty one used to mint fine and then collide with the next empty one. It now refuses spaces and punctuation beyond dots, dashes and underscores, and the API enforces the same rule from the same place. — `0.3.168` (`61fa598`)
- `NIGHTWARDEN_CONSOLE_DIST` is now `NIGHTWARDEN_FRONTEND_DIST`. It is an override for running the bundle from an unusual layout, so an ordinary install never set it. — `0.3.167` (`f3a62d3`)
- **The licence is now the Fair Core License 1.0 (FCL-1.0-ALv2)**, replacing AGPL-3.0. Self-hosting NightWarden for your own operations stays free and unlimited; what the licence withholds is a Competing Use - offering NightWarden to others in a commercial product or service that substitutes for it. Each version becomes Apache-2.0 two years after its release, irrevocably. This is source available, not open source, and the README no longer says otherwise. — `0.3.165` (`26002ac`)
- **Reasoning is always on.** Settings offers only the model's own effort ladder; the **Off** option is gone. A model told not to reason writes its tool calls as prose instead of calling them, so the run does nothing while looking busy. Session titles now use the weakest rung the model publishes instead. — `0.3.164` (`f5cd6fe`)
- **Deleting a session discards its sandbox work.** It no longer commits and pushes to your repository on the way out. Every other way a sandbox ends still saves the work first. — `0.3.164` (`f5cd6fe`)
- **Action required** on the Investigations page now means a run is frozen waiting on you, and nothing else. A finished investigation whose recommendation nobody has acted on moves to **Completed**, where its recommendation still reads on the row. Nothing marks a recommendation as acted on, so the old group could only ever grow. — `0.3.162` (`d553ea9`)

### Removed

- **Starting an investigation by hand.** The mode picker beside the message box is gone and `POST /api/chat` refuses `kind: "investigation"`; typing opens a chat, and an alert opens an investigation. An investigation is a session with a falsifiable condition attached, and only an alert carries one - so a manually started investigation could never have its recovery confirmed, and produced a report nothing could ever verify. The investigations list, the record and the report are unchanged, and stopping or resuming a session works exactly as before. — `0.3.175`

- The **container** field on `GetK8sConfig`, `GetK8sStats`, `GetK8sEvents` and `RestartK8sWorkload`. All four report on the whole workload and none ever read it; it stays on the three tools that do. — `0.3.171` (`f49f9c8`)
- The **Inconclusive** status. A finished run reads **Completed** whatever its record holds, and what it found or ruled out reads on the row beneath it. — `0.3.162` (`d553ea9`)

### Security

- An alert label can no longer close the harness tag and speak as NightWarden. Anything the harness sends the model is stripped of the marker first, so text arriving from a monitored host reaches the model as data rather than as an instruction wearing the system's voice. — `0.3.157` (`bea9083`)

### Fixed

- The log tools no longer claim to filter down to error and warning lines. They never did: the newest lines are read and only your own `contains` and `excludes` narrow them. An agent told otherwise read a thin result as a quiet service. — `0.3.171` (`f49f9c8`)
- `warningsOnly` on `GetK8sEvents` now reaches the cluster. The runner's dispatch dropped it, so asking for Normal events silently returned Warnings only. — `0.3.171` (`f49f9c8`)
- `filterLevel` on `GetHostDmesg` now selects a severity: `err` returns errors alone and `warn` returns errors and warnings. Both returned the same two levels before. — `0.3.171` (`f49f9c8`)
- An investigation can no longer finish with reads nothing on its record accounts for. The mid-run check that asks about them was clearing the very debt the finish gate reads. — `0.3.170` (`a447577`)
- Reinstalling a runner whose platform API is unreachable no longer deletes its credential. A name was reclaimable until the runner sent a manifest, which such a runner never does, though it authenticates fine. — `0.3.170` (`a447577`)
- The Investigations page draws the alert queue band after a reload. It was only ever filled in by a live event, so a page opened while alerts waited showed nothing. — `0.3.170` (`a447577`)
- A resolved alert clears only the firing it names, matched on its fingerprint and its start time together. A recovery can no longer resolve an older incident that shares the fingerprint. — `0.3.159` (`8213a6f`)
- An approved command's result is written to the transcript in the same transaction that clears its approval gate, so a crash in that instant no longer loses the investigation the command was part of. — `0.3.157` (`bea9083`)
- A refused citation names only evidence ids that were actually issued. It previously counted every tool call, so the range it offered grew by one on each failed attempt. — `0.3.158` (`e8fe463`)
- A claim citing an unanswered or invented evidence id is refused whole, rather than recorded citing only what survived and silently earning a lower conviction than the model was told it had. — `0.3.158` (`e8fe463`)
