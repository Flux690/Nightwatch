import type { DeployInfo, GetRecentDeploysInput } from "@nightwatch/shared";
import { getDocker } from "../docker-client.js";

interface ImageLayer {
  Id: string;
  Created: number;
}

export async function getRecentDeploys(
  input: GetRecentDeploysInput,
): Promise<DeployInfo> {
  const { containerName } = input;
  const docker = getDocker();

  const inspect = await docker.getContainer(containerName).inspect();
  const currentImageDigest = inspect.Image;
  const createdAt = inspect.Created;

  let previousImageDigest: string | undefined;
  let imageChangedAt: string | undefined;
  let timeSinceChangeMinutes: number | undefined;

  try {
    const history = (await docker
      .getImage(currentImageDigest)
      .history()) as ImageLayer[];
    const prev = history[1];
    if (prev && prev.Id && prev.Id !== "<missing>") {
      previousImageDigest = prev.Id;
      const created = new Date(prev.Created * 1000);
      imageChangedAt = created.toISOString();
      timeSinceChangeMinutes = Math.round(
        (Date.now() - created.getTime()) / 60_000,
      );
    }
  } catch {
    // image history is non-critical; proceed without it
  }

  return {
    currentImageDigest,
    currentImageCreatedAt: createdAt,
    previousImageDigest,
    imageChangedAt,
    timeSinceChangeMinutes,
  };
}
