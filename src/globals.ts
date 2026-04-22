import type { Infrastructure } from "./orchestration/composeLoader";
import type { NightwatchConfig } from "./config";

let _infrastructure: Infrastructure | null = null;
let _config: NightwatchConfig | null = null;

export function setContext(
  infra: Infrastructure,
  config: NightwatchConfig,
): void {
  _infrastructure = infra;
  _config = config;
}

export function getInfrastructure(): Infrastructure {
  if (!_infrastructure) {
    throw new Error(
      "Infrastructure not initialized. Call setContext() at startup.",
    );
  }
  return _infrastructure;
}

export function getConfig(): NightwatchConfig {
  if (!_config) {
    throw new Error("Config not initialized. Call setContext() at startup.");
  }
  return _config;
}
