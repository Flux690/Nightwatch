import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DeployInfo, GetRecentDeploysInput } from "@nightwatch/shared";

const exec = promisify(execFile);

export async function getRecentDeploys(
  input: GetRecentDeploysInput,
): Promise<DeployInfo> {
  const { containerName } = input;
  const { stdout: inspectOut } = await exec("docker", [
    "inspect",
    containerName,
  ]);
  const arr = JSON.parse(inspectOut) as Array<Record<string, unknown>>;
  const raw = arr[0];
  if (!raw) throw new Error(`Container not found: ${containerName}`);

  const currentImageDigest = String(raw["Image"] ?? "");
  const createdAt = String(
    (raw["Created"] as string | undefined) ?? new Date().toISOString(),
  );

  const { stdout: historyOut } = await exec("docker", [
    "image",
    "history",
    "--format",
    "{{json .}}",
    currentImageDigest,
  ]).catch(() => ({ stdout: "" }));

  let previousImageDigest: string | undefined;
  let imageChangedAt: string | undefined;
  let timeSinceChangeMinutes: number | undefined;

  if (historyOut) {
    const historyLines = historyOut
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, string>);

    const prev = historyLines[1];
    if (prev) {
      previousImageDigest = prev["ID"] ?? undefined;
      const createdStr = prev["CreatedAt"];
      if (createdStr) {
        imageChangedAt = createdStr;
        const created = new Date(createdStr);
        timeSinceChangeMinutes = Math.round(
          (Date.now() - created.getTime()) / 60_000,
        );
      }
    }
  }

  return {
    currentImageDigest,
    currentImageCreatedAt: createdAt,
    previousImageDigest,
    imageChangedAt,
    timeSinceChangeMinutes,
  };
}
