// In-memory remediation mode for this process: seeded from REMEDIATION_ENABLED, updated
// live by set_remediation_mode pushes. Never persisted, so the runner stays stateless.
let _enabled = process.env["REMEDIATION_ENABLED"] === "true";

export function isRemediationEnabled(): boolean {
  return _enabled;
}

export function setRemediationEnabled(enabled: boolean): void {
  _enabled = enabled;
}
