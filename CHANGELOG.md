# Changelog

Every notable change to NightWarden, newest first. The format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versioning is [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

An entry says what a user can now do differently. A change nobody outside this repository can notice does not go in, which is what keeps this from becoming a second copy of the commit log.

Each entry closes with the version it shipped in and the commit that made it, so the reasoning behind a line is one `git show` away.

NightWarden has not had a public release. Everything below `1.0.0` is a prelaunch development build: the API, the runner protocol and the database schema all change freely, and `1.0.0` will be the first public stable release.

## [Unreleased]

### Added

- **You can change your password in the app, and see which devices are signed in.** Settings → Account now shows the account you are signed in as, a change-password form, and a list of signed-in browsers with a Revoke button on each. Changing your password signs out every other device. Previously there was no way to change a password at all: the only documented recovery was wiping the volume and setting the install up again. — `0.5.0` (`0581fa8`)

- **Sentry, as an evidence source.** Connect it under Integrations with a base URL, your organization slug and an auth token carrying `event:read` and `project:read`; both scopes are probed before the connection is saved, so a token missing one is refused with the scope named rather than failing mid-incident. Investigations gain five read-only tools: search the issues around the alert, read one issue's latest event with its stack trace, break an issue down by a tag such as `server_name`, list releases with how long before or after the alert each was deployed, and list the commits in a release with the pull request and Sentry's suspect-commit marker. Self-hosted Sentry and sentry.io both work. Nothing is written back to Sentry. — `0.4.0` (`2ac6804`)

- **Upgrading no longer deletes your database.** Schema changes now ship as migrations the API applies on boot, each in its own transaction, and it refuses to start rather than serve a half-migrated schema. Nothing to run by hand. — `0.3.174` (`c306689`)

- **The API image now carries the licence text of every package bundled into the frontend**, served at `/THIRD-PARTY-LICENSES.txt` and written at build time from what Vite actually bundles. Vite inlines those packages into the browser assets, so unlike an installed dependency their own licence files never reached the image. The README's License section now names where every set of terms lives. — `0.3.173` (`f9923f8`)

### Changed

- **A report timeline entry has to carry a real timestamp.** The `at` field took any non-empty string, so a moment could be written as "around 03:10" and the report rendered it as given, next to entries that were exact. It now has to be an ISO 8601 timestamp carrying a timezone, so every row on a timeline can be placed against the others. — `0.5.6` (`d367643`)

- **A tool call in the transcript is now one row naming the tool it called.** Every row used to carry a one-line summary of what the call returned, together with a status word such as "Permission denied" or "Unavailable". Two of those words shared a colour, the one for a query that found nothing was blank, and none of them said more than the result itself does. The row is now the tool's name, the service it addressed, and a chevron; what the call returned is one click inside it. — `0.5.5` (`52a2a7b`)

- **Every limit a tool places on its arguments is now stated in that argument's own description.** A bound like "must be above zero" was declared in code but deleted before the model ever saw the schema, so a call could be refused for a rule the model was never told. Whole-number fields now say they are whole numbers, and every floor and ceiling is written where the model reads it. A test fails the build if a new field carries a bound its description does not state. — `0.5.3` (`e7a4022`)

- **Tool schemas are now built for whichever model provider you picked.** The schema sent to Anthropic and the schema sent through OpenRouter are each reduced to what that provider documents itself as accepting, instead of both receiving one shape derived from Anthropic's rules. Switching provider no longer risks a tool being refused for a keyword the other one happened to allow. — `0.5.3` (`e7a4022`)

- **A tool asked for more than its limit is now refused, instead of quietly given less.** Asking a metrics or log query to look back further than its maximum used to shorten the window without saying so, so the agent could read one week while believing it had read two, and conclude that nothing happened. The call is now refused with the field named, and the agent asks again with a value that fits. Every tool's arguments are also checked against one definition now, so what a tool's description promises and what its code accepts can no longer drift apart. — `0.5.3` (`e7a4022`)

- **A bad request now says which field is wrong, in plain words.** Connecting Loki, Sentry or a metrics source with a malformed body used to answer with Zod's raw issues array as JSON; it now names the field and what it needs, the same way the Agent settings already did. Starting a chat without a message, asking for an investigation by hand, or passing a page size outside 1 to 200 each say so precisely, and a runner is told which field of which object it got wrong rather than only that something was invalid. — `0.5.2` (`d5b793b`)

- **`DockerBash` and `K8sBash` are now `DockerExec` and `K8sExec`, and they take a program and its arguments as separate fields.** Neither ever ran a shell: both hand the command straight to `docker exec` and `kubectl exec`, so a pipe or a semicolon was always passed through as ordinary text while the tool's own name and description promised otherwise. They now say what they do, and the command is given as `executable` plus `args` rather than one array whose first element silently had to be the program. To run a pipeline, name a shell as the executable and pass the script as one argument. **Upgrade the API and your runners together**: the two exchange a new shape for these calls and for restarts, so a runner left on the old image will refuse them. Approvals, transcripts and reports are otherwise unchanged, and older sessions keep rendering. — `0.5.1` (`84cab5d`)

- **The approval card no longer prints the agent's own risk rating.** Every gated call used to carry the model's guess at how much damage it could do, shown as "The agent calls this low risk" beside the command. It decided nothing, it could be swayed by text the agent read on your servers, and it sat next to the one thing that actually answers the question - the command itself. The reason the agent gives for the call, which you cannot work out for yourself, stays. — `0.5.1` (`84cab5d`)

- **Sign-in is handled by Better Auth, and sessions are rows rather than signed cookies.** Signing out one device now ends that device's session alone, and a revoked session stops working immediately instead of when its cookie expires. The first-boot setup form asks for your name as well as an email and password, because that name is what an approval record will carry. **Your existing owner account does not survive this upgrade**: the schema for accounts changed, so an install that had one comes back to the setup screen and creates it again. Nothing else in the database is touched. — `0.5.0` (`0581fa8`)

- **The one secret is now two, and they fail apart.** `secret.key` encrypts stored credentials; a new `auth.key` beside it signs sessions. Previously a single value did both, so deleting it both signed everyone out and made every stored API key unreadable. Both are generated on first boot and can be set with `NIGHTWARDEN_SECRET_KEY` and `NIGHTWARDEN_AUTH_SECRET`. Existing installs keep their `secret.key`, so stored credentials are unaffected. — `0.5.0` (`0581fa8`)

- **The licence is the GNU Affero General Public License v3.0 again**, replacing FCL-1.0-ALv2. NightWarden is open source: you may run it for any purpose, including commercially, and the only obligation is the AGPL's own - if you run a modified version as a network service, its users may ask you for the source. The Fair Core License was adopted to prevent a competitor hosting NightWarden, which the AGPL does not prevent; it also excluded the project from the CNCF landscape and from every distribution that requires an OSI-approved licence, which is a real cost against a theoretical risk. — `0.4.1` (`cdd45fe`)

- **The session list requires a `kind`.** `GET /api/sessions` now answers 400 without `?kind=investigation` or `?kind=chat`. The unfiltered shape no index could serve, and nothing asked for it; every page in the frontend already sent one. — `0.3.174` (`c306689`)

- **One metrics source, not one per product.** Connecting Prometheus now closes the VictoriaMetrics, Mimir, Thanos and AMP cards until you disconnect it, and the agent no longer names a source on any metrics call. What you point at is already an aggregate, so the second connection was a setting that could only ever disagree with itself. — `0.3.172` (`9cc8481`)
- **Docker and Kubernetes logs carry a timestamp on every line**, the one the engine recorded, so a log line can be placed against the moment the alert fired. `contains` and `excludes` now match the message alone rather than the timestamp beside it. — `0.3.171` (`f49f9c8`)
- **A runner no longer carries a separate label.** The column was left over from when the wizard's field was a cosmetic display name; nothing has written to it since that field became the server name. — `0.3.169` (`fcb134e`)
- **A runner's name is required, and it is the server name.** The add-runner wizard called it "Display name (optional)" and it was never either: it is the first segment of every service address the agent copies, and the column is unique. An empty one used to be accepted and then collide with the next empty one. It now refuses spaces and punctuation beyond dots, dashes and underscores, and the API enforces the same rule from the same place. — `0.3.168` (`61fa598`)
- `NIGHTWARDEN_CONSOLE_DIST` is now `NIGHTWARDEN_FRONTEND_DIST`. It is an override for running the bundle from an unusual layout, so an ordinary install never set it. — `0.3.167` (`f3a62d3`)
- **The licence is now the Fair Core License 1.0 (FCL-1.0-ALv2)**, replacing AGPL-3.0. Self-hosting NightWarden for your own operations stays free and unlimited; what the licence withholds is a Competing Use - offering NightWarden to others in a commercial product or service that substitutes for it. Each version becomes Apache-2.0 two years after its release, irrevocably. This is source available, not open source, and the README no longer says otherwise. — `0.3.165` (`26002ac`)
- **Reasoning is always on.** Settings offers only the model's own effort ladder; the **Off** option is gone. A model told not to reason writes its tool calls as prose instead of calling them, so the run does nothing while looking busy. Session titles now use the weakest rung the model publishes instead. — `0.3.164` (`f5cd6fe`)
- **Deleting a session discards its sandbox work.** It no longer commits and pushes to your repository on the way out. Every other way a sandbox ends still saves the work first. — `0.3.164` (`f5cd6fe`)
- **Action required** on the Investigations page now means a run is frozen waiting on you, and nothing else. A finished investigation whose recommendation nobody has acted on moves to **Completed**, where its recommendation still reads on the row. Nothing marks a recommendation as acted on, so the old group could only ever grow. — `0.3.162` (`d553ea9`)

### Removed

- **Starting an investigation by hand.** The mode picker beside the message box is gone and `POST /api/chat` refuses `kind: "investigation"`; typing opens a chat, and an alert opens an investigation. An investigation is a session with a falsifiable condition attached, and only an alert carries one - so a manually started investigation could never have its recovery confirmed, and produced a report nothing could ever verify. The investigations list, the record and the report are unchanged, and stopping or resuming a session works exactly as before. — `0.4.0` (`e0f52ba`)

- The **container** field on `GetK8sConfig`, `GetK8sStats`, `GetK8sEvents` and `RestartK8sWorkload`. All four report on the whole workload and none ever read it; it stays on the three tools that do. — `0.3.171` (`f49f9c8`)
- The **Inconclusive** status. A finished run reads **Completed** whatever its record holds, and what it found or ruled out reads on the row beneath it. — `0.3.162` (`d553ea9`)

### Security

- An alert label can no longer close the harness tag and speak as NightWarden. Anything the harness sends the model is stripped of the marker first, so text arriving from a monitored host reaches the model as data rather than as an instruction wearing the system's voice. — `0.3.157` (`bea9083`)

### Fixed

- **A tool call is no longer refused for an argument the model chose to leave out.** OpenRouter's schema dialect has no optional argument: every field is required, and an optional one is offered as "a value or null", so a model skipping a field sends null. NightWarden then rejected the call as malformed and asked the model to correct it, spending a turn each time on a call that was already right. A null now reads as the omission it means, wherever it appears in the arguments. — `0.5.6` (`d367643`)

- **A released write that the provider refused no longer reports as having run.** The report's actions list read a write as "Ran" unless the tool crashed or timed out, so a `403` from GitHub on an approved pull request, or a rejected token, showed alongside the writes that succeeded. Any released write that failed now reads as "Failed". — `0.5.5` (`52a2a7b`)

- **A search that matched nothing now counts as a read.** The agent is nudged to record what it has settled once it has read enough without settling anything, and a query returning no rows was excluded from that count, so an investigation that ruled things out by finding nothing could read indefinitely without being asked. A call that answered counts whether or not it found something; only a call that failed does not. — `0.5.5` (`52a2a7b`)

- **A response NightWarden cannot read is now reported as unreadable, instead of as an empty result.** Every reply from your metrics source, Loki, Sentry and GitHub used to be read field by field, and any field that did not look as expected became an empty list or a blank string. An investigation was therefore told "no changes were merged" or "no log lines matched" when the truth was that the answer could not be parsed at all, which is indistinguishable from a healthy service. Each response is now checked against the shape its vendor documents, and a reply that does not match fails the tool call with the field named, so the agent records an unknown rather than a finding. — `0.5.4` (`09f0a23`)

- **A metrics query that returns one number now reports that number.** A PromQL expression producing a single value, such as `scalar(sum(up))`, came back as two series with no data points, because a scalar's result is a `[time, value]` pair and it was being read as a list. — `0.5.4` (`09f0a23`)

- **A native histogram is now named instead of appearing to hold nothing.** Histogram series carry their points under different keys, so a query against one showed a series with zero points. The result now reports the observation count per point, says that is what it is, and tells the agent to use `histogram_quantile()` for a percentile. — `0.5.4` (`09f0a23`)

- **A partial read is no longer presented as a complete one.** Prometheus, Thanos and Mimir answer with data _and_ a warning when part of the query could not be served, typically because a store was unreachable. Those warnings were dropped, so a six-hour window that returned two hours of data read as the whole window, and an investigation could date an incident wrong. Every metrics result now carries them, including when the partial read returned nothing at all. — `0.5.4` (`09f0a23`)

- **Metric name discovery on VictoriaMetrics no longer silently covers only today.** VictoriaMetrics defaults its label endpoints to the day so far, where Prometheus defaults to all time, so `ListMetricNames` could omit a metric that had existed for a year but had not been written since midnight, and the agent would read that as the metric not existing. The window is now sent explicitly and stated in the result. — `0.5.4` (`09f0a23`)

- **Two integration cards no longer state something untrue.** VictoriaMetrics is described as needing `-enableMetadata` and v1.130.0 for metric metadata, rather than as never implementing it; and the Amazon Managed Prometheus card no longer warns that recovery confirmation is unverified, which AWS's own `ListRules` API settles. — `0.5.4` (`09f0a23`)

- **A Sentry result can be cited, so an exception or a release can support a claim.** The five Sentry tools answered and were rendered, but were never issued an evidence id, and a hypothesis needs at least one citation - so a cause found in a stack trace or a release timeline could not be recorded at all unless something else happened to back it. Sentry also now counts as its own evidence family, so a claim resting on Sentry plus metrics or logs reads as corroborated rather than cited. — `0.4.2` (`18dd175`)

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
