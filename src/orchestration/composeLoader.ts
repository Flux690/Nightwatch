/**
 * Docker Compose file parser with auto-discovery and multi-file support.
 */

import { readFileSync, existsSync, statSync } from "fs";
import { parse as parseYaml } from "yaml";
import path from "path";

export type Infrastructure = {
  raw: string;
  containers: string[];
  composePaths: string[];
  basePath: string;
};

const COMPOSE_FILENAMES = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
];

function discoverComposeFile(dir: string): string {
  for (const name of COMPOSE_FILENAMES) {
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `No compose file found in ${dir}. Use --compose to specify the path.`,
  );
}

function parseComposeFile(filePath: string): {
  raw: string;
  containers: string[];
} {
  const raw = readFileSync(filePath, "utf-8");
  const parsed = parseYaml(raw) as {
    services: Record<string, { container_name?: string }>;
  };

  const containers = Object.entries(parsed.services).map(
    ([serviceName, service]) => service.container_name ?? serviceName,
  );

  return { raw, containers };
}

export function loadInfrastructure(composeArg?: string): Infrastructure {
  let resolvedPaths: string[];

  if (!composeArg) {
    // Auto-discover in current directory
    resolvedPaths = [discoverComposeFile(process.cwd())];
  } else if (composeArg.includes(",")) {
    // Comma-separated paths
    resolvedPaths = composeArg.split(",").map((p) => {
      const resolved = path.resolve(p.trim());
      if (!existsSync(resolved)) {
        throw new Error(`Compose file not found: ${resolved}`);
      }
      return resolved;
    });
  } else {
    // Single path — file or directory
    const resolved = path.resolve(composeArg);
    if (!existsSync(resolved)) {
      throw new Error(`Compose file not found: ${resolved}`);
    }

    if (statSync(resolved).isDirectory()) {
      resolvedPaths = [discoverComposeFile(resolved)];
    } else {
      resolvedPaths = [resolved];
    }
  }

  const allRaw: string[] = [];
  const allContainers: Set<string> = new Set();

  for (const filePath of resolvedPaths) {
    const { raw, containers } = parseComposeFile(filePath);
    allRaw.push(raw);
    for (const c of containers) {
      allContainers.add(c);
    }
  }

  return {
    raw: allRaw.join("\n---\n"),
    containers: [...allContainers],
    composePaths: resolvedPaths,
    basePath: path.dirname(resolvedPaths[0]),
  };
}
