import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  ExecCommandInput,
  ExecCommandResult,
  RestartContainerInput,
  RestartContainerResult,
} from "@nightwatch/shared";
import { getDocker, parseDockerMux } from "../docker-client.js";
import {
  notRunningResult,
  resolveService,
  type NoRunningInstanceResult,
} from "../docker/resolve-service.js";
import { sanitizeExecOutput } from "../safety/allowlist.js";

const RULES_PATH =
  process.env["NIGHTWATCH_RULES_PATH"] ?? "/etc/nightwatch/rules.yml";
const RULES_OVERRIDE_PATH =
  process.env["NIGHTWATCH_RULES_OVERRIDE_PATH"] ?? "/var/nightwatch/rules.yml";
const PROMETHEUS_URL = process.env["PROMETHEUS_URL"] ?? "http://localhost:9090";

export interface UpdateAlertRulesResult {
  reloaded: boolean;
  rulesPath: string;
}

export async function updateAlertRules(input: {
  rulesYaml: string;
}): Promise<UpdateAlertRulesResult> {
  await mkdir(dirname(RULES_OVERRIDE_PATH), { recursive: true });
  await writeFile(RULES_OVERRIDE_PATH, input.rulesYaml, "utf8");
  await writeFile(RULES_PATH, input.rulesYaml, "utf8");

  // /-/reload exists only with --web.enable-lifecycle; a failed reload is
  // non-fatal since the file is written and loads on the next restart.
  let reloaded = false;
  try {
    const res = await fetch(`${PROMETHEUS_URL}/-/reload`, { method: "POST" });
    reloaded = res.ok;
  } catch {
    reloaded = false;
  }

  return { reloaded, rulesPath: RULES_PATH };
}

export async function restartContainer(
  input: RestartContainerInput,
): Promise<RestartContainerResult | NoRunningInstanceResult> {
  const startedAt = new Date().toISOString();
  const docker = getDocker();
  // Restart is a write action on a live target (CONTEXT.md); a stopped
  // instance is "nothing to act on", not a target to restart.
  const resolved = await resolveService(docker, input.service);
  if (!resolved || !resolved.live) return notRunningResult(input.service);
  const container = resolved.container;

  const before = await container.inspect();
  const previousExitCode = before.State.ExitCode ?? 0;

  if (input.delaySeconds && input.delaySeconds > 0) {
    await new Promise((r) => setTimeout(r, input.delaySeconds! * 1000));
  }

  await container.restart();

  const after = await container.inspect();
  const newStatus = after.State.Status ?? "unknown";

  return {
    success: newStatus === "running",
    startedAt,
    previousExitCode,
    newStatus,
  };
}

export async function execCommand(
  input: ExecCommandInput,
): Promise<ExecCommandResult | NoRunningInstanceResult> {
  const executedAt = new Date().toISOString();
  const [cmd, ...args] = input.command;
  if (!cmd) throw new Error("command array must not be empty");

  const docker = getDocker();
  // Exec is a write action on a live target (CONTEXT.md); a stopped instance
  // is "nothing to act on", not a degraded-but-usable target like logs/inspect.
  const resolved = await resolveService(docker, input.service);
  if (!resolved || !resolved.live) return notRunningResult(input.service);
  const container = resolved.container;

  const exec = await container.exec({
    Cmd: [cmd, ...args],
    AttachStdout: true,
    AttachStderr: true,
  });

  const stream = await exec.start({});
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });

  const raw = parseDockerMux(Buffer.concat(chunks));
  const info = await exec.inspect();

  return {
    exitCode: info.ExitCode ?? 0,
    stdout: sanitizeExecOutput(raw.stdout),
    stderr: sanitizeExecOutput(raw.stderr),
    executedAt,
  };
}
