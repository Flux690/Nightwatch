/**
 * Docker Compose file parser.
 */

import { readFileSync } from "fs";
import { parse as parseYaml } from "yaml";
import path from "path";

const COMPOSE_PATH = path.resolve(process.cwd(), "docker-compose.yaml");

function loadCompose() {
  const raw = readFileSync(COMPOSE_PATH, "utf-8");
  const parsed = parseYaml(raw) as {
    services: Record<string, { container_name?: string }>;
  };

  // Extract container names (use container_name if specified, else service name)
  const containers = Object.entries(parsed.services).map(
    ([serviceName, service]) => service.container_name ?? serviceName,
  );

  return { raw, containers };
}

export const infrastructure = loadCompose();
