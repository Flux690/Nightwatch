import type Dockerode from "dockerode";
import { listVisibleContainers } from "./client.js";
import type {
  DockerServiceIdentity,
  NotFoundResult,
} from "@nightwarden/shared";

export interface ResolvedContainer {
  container: Dockerode.Container;
  id: string;
  name: string;
  live: boolean;
}

// Docker's own vocabulary for a miss, phrased in Docker's own nouns.
export function noContainerResult(
  service: DockerServiceIdentity,
  reason?: string,
): NotFoundResult {
  return {
    found: false,
    reason:
      reason ??
      `No running container found for ${service.project}/${service.service}`,
  };
}

// Resolve a durable identity to the live container now, falling back to the most recently terminated
// instance when none is live; callers needing a live target reject a `live:false` result themselves.
export async function resolveService(
  docker: Dockerode,
  service: DockerServiceIdentity,
): Promise<ResolvedContainer | null> {
  const all = await listVisibleContainers(docker);
  const matches = all.filter((c) => matchesIdentity(c, service));
  if (matches.length === 0) return null;

  // A rolling redeploy can briefly leave the old and new instance live
  // together; prefer the newest live one, never an older one by array order.
  const liveMatches = matches.filter((c) => c.State === "running");
  const chosen =
    liveMatches.length > 0
      ? mostRecentlyCreated(liveMatches)
      : mostRecentlyCreated(matches);

  return {
    container: docker.getContainer(chosen.Id),
    id: chosen.Id,
    name: (chosen.Names[0] ?? "").replace(/^\//, ""),
    live: chosen.State === "running",
  };
}

function matchesIdentity(
  c: Dockerode.ContainerInfo,
  service: DockerServiceIdentity,
): boolean {
  const labels = c.Labels ?? {};
  if (
    labels["com.docker.compose.project"] === service.project &&
    labels["com.docker.compose.service"] === service.service
  ) {
    return true;
  }
  // Anonymous `docker run` containers carry no Compose labels; the identity's
  // `service` field is the live name captured at discovery time.
  const name = (c.Names[0] ?? "").replace(/^\//, "");
  return name === service.service;
}

function mostRecentlyCreated(
  matches: Dockerode.ContainerInfo[],
): Dockerode.ContainerInfo {
  return matches.reduce((newest, c) =>
    c.Created > newest.Created ? c : newest,
  );
}
