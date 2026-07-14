// In-memory remediation mode, updated live by set_remediation_mode pushes from the API. Defaults to
// true; the API is the authority and pushes the DB value on each manifest reconciliation. Never persisted, so the runner stays stateless.
let _enabled = true;

export function isRemediationEnabled(): boolean {
  return _enabled;
}

export function setRemediationEnabled(enabled: boolean): void {
  _enabled = enabled;
}
