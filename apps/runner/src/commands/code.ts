import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { isPathAllowed, redactSecrets } from "../safety/allowlist.js";
import type {
  DeployInfo,
  GetEnvVariableNamesInput,
  GetRecentDeploysInput,
  ReadFileInput,
  ReadFileResult,
} from "@nightwatch/shared";

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

export async function getEnvVariableNames(
  input: GetEnvVariableNamesInput,
): Promise<{ names: string[] }> {
  const { stdout } = await exec("docker", ["inspect", input.containerName]);
  const arr = JSON.parse(stdout) as Array<Record<string, unknown>>;
  const raw = arr[0];
  if (!raw) throw new Error(`Container not found: ${input.containerName}`);

  const config = raw["Config"] as Record<string, unknown> | undefined;
  const env = (config?.["Env"] as string[] | undefined) ?? [];
  const names = env.map((e) => e.split("=")[0] ?? e);

  return { names };
}

export async function readFileCommand(
  input: ReadFileInput,
): Promise<ReadFileResult> {
  if (!isPathAllowed(input.path)) {
    throw new Error(
      `Path not in allowlist: ${input.path}. Add to FILE_ALLOWLIST env var to enable.`,
    );
  }

  const raw = await readFile(input.path, "utf8");
  const maxLines = input.maxLines ?? 500;
  const allLines = raw.split("\n");
  const sliced = allLines.slice(0, maxLines).join("\n");
  const { content, redactedCount } = redactSecrets(sliced);

  return {
    content,
    lineCount: Math.min(allLines.length, maxLines),
    path: input.path,
    redactedLineCount: redactedCount,
  };
}
