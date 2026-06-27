import type Dockerode from "dockerode";
import type {
  DockerServiceIdentity,
  ServiceIdentity,
} from "@nightwatch/shared";
import {
  notRunningResult,
  type NoRunningInstanceResult,
} from "../resolve-result.js";

export interface ResolvedContainer {
  container: Dockerode.Container;
  id: string;
  name: string;
  live: boolean;
}

export { notRunningResult, type NoRunningInstanceResult };

// Tool inputs carry the cross-provider ServiceIdentity union; a Docker runner
// can only ever resolve the Docker arm. A non-docker identity reaching here is
// a routing/model bug, not a missing-container finding (user story 19, ADR-0002).
function requireDockerIdentity(
  service: ServiceIdentity,
): DockerServiceIdentity {
  if (service.provider !== "docker") {
    throw new Error(
      `This runner only supports Docker; received a '${service.provider}' service identity.`,
    );
  }
  return service;
}

// Resolves a durable service identity to the live container at the moment of
// the call (docs/adr/0001). Falls back to the most recently created
// stopped/terminated instance when nothing is live; callers that require a
// live target reject a `live: false` result themselves.
export async function resolveService(
  docker: Dockerode,
  identity: ServiceIdentity,
): Promise<ResolvedContainer | null> {
  const service = requireDockerIdentity(identity);
  const all = await docker.listContainers({ all: true });
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
  // `service` field is the live name captured at discovery time (ADR-0001).
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
