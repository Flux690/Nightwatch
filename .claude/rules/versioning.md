# Versioning Rules

- Single version number for the whole product, in the root `package.json` only.
  Never edit the `version` field in `apps/*/package.json` or
  `packages/shared/package.json` - those stay fixed and are not meaningful on
  their own.
- Semver: `MAJOR.MINOR.PATCH`.
  - PATCH: bug fixes, no behavior change to working features.
  - MINOR: new backward-compatible functionality. Resets PATCH to 0.
  - MAJOR: breaking change. Resets MINOR and PATCH to 0.
- Bump the root version as part of the commit that makes the change, not on a
  separate cadence. Default to a patch bump unless the change is clearly a new
  feature (minor) or breaking (major).
