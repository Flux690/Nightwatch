// In-memory remediation mode for this runner process. Initialized from the
// REMEDIATION_ENABLED env var (install-time bootstrap default) and updated
// live via set_remediation_mode pushes from the API. The runner never persists
// this value - it stays stateless, holding it only in memory.
let _enabled = process.env["REMEDIATION_ENABLED"] === "true";

export function isRemediationEnabled(): boolean {
  return _enabled;
}

export function setRemediationEnabled(enabled: boolean): void {
  _enabled = enabled;
}
