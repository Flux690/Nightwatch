# Changelog

Every notable change to NightWarden, newest first. The format is
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versioning is
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

An entry says what a user can now do differently. A change nobody outside this
repository can notice does not go in, which is what keeps this from becoming a
second copy of the commit log.

NightWarden has not had a public release. Everything below `1.0.0` is a
prelaunch development build: the API, the runner protocol and the database
schema all change freely, and `1.0.0` will be the first public stable release.

## [Unreleased]

### Changed

- **The licence is now the Fair Core License 1.0 (FCL-1.0-ALv2)**, replacing
  AGPL-3.0. Self-hosting NightWarden for your own operations stays free and
  unlimited; what the licence withholds is a Competing Use - offering NightWarden
  to others in a commercial product or service that substitutes for it. Each
  version becomes Apache-2.0 two years after its release, irrevocably. This is
  source available, not open source, and the README no longer says otherwise.
- **Reasoning is always on.** Settings offers only the model's own effort
  ladder; the **Off** option is gone. A model told not to reason writes its tool
  calls as prose instead of calling them, so the run does nothing while looking
  busy. Session titles now use the weakest rung the model publishes instead.
- **Deleting a session discards its sandbox work.** It no longer commits and
  pushes to your repository on the way out. Every other way a sandbox ends still
  saves the work first.
- **Action required** on the Investigations page now means a run is frozen
  waiting on you, and nothing else. A finished investigation whose
  recommendation nobody has acted on moves to **Completed**, where its
  recommendation still reads on the row. Nothing marks a recommendation as acted
  on, so the old group could only ever grow.

### Removed

- The **Inconclusive** status. A finished run reads **Completed** whatever its
  record holds, and what it found or ruled out reads on the row beneath it.

### Security

- An alert label can no longer close the harness tag and speak as NightWarden.
  Anything the harness sends the model is stripped of the marker first, so text
  arriving from a monitored host reaches the model as data rather than as an
  instruction wearing the system's voice.

### Fixed

- A resolved alert clears only the firing it names, matched on its fingerprint
  and its start time together. A recovery can no longer resolve an older
  incident that shares the fingerprint.
- An approved command's result is written to the transcript in the same
  transaction that clears its approval gate, so a crash in that instant no
  longer loses the investigation the command was part of.
- A refused citation names only evidence ids that were actually issued. It
  previously counted every tool call, so the range it offered grew by one on
  each failed attempt.
- A claim citing an unanswered or invented evidence id is refused whole, rather
  than recorded citing only what survived and silently earning a lower
  conviction than the model was told it had.
