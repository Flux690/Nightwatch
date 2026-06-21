import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  ExecCommandInput,
  ExecCommandResult,
  RestartContainerInput,
  RestartContainerResult,
  RollbackDeployInput,
  RollbackDeployResult,
} from "@nightwatch/shared";
import { getDocker, parseDockerMux } from "../docker-client.js";

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
): Promise<RestartContainerResult> {
  const startedAt = new Date().toISOString();
  const docker = getDocker();
  const container = docker.getContainer(input.containerName);

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

export async function rollbackDeploy(
  _input: RollbackDeployInput,
): Promise<RollbackDeployResult> {
  throw new Error(
    "rollback_deploy is not yet implemented. Requires docker-compose file path and compose context.",
  );
}

export async function execCommand(
  input: ExecCommandInput,
): Promise<ExecCommandResult> {
  if (process.env["REMEDIATION_ENABLED"] !== "true") {
    throw new Error(
      "exec_command is disabled. Set REMEDIATION_ENABLED=true on the runner to enable.",
    );
  }

  const executedAt = new Date().toISOString();
  const [cmd, ...args] = input.command;
  if (!cmd) throw new Error("command array must not be empty");

  const docker = getDocker();
  const container = docker.getContainer(input.containerName);

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

  const { stdout, stderr } = parseDockerMux(Buffer.concat(chunks));
  const info = await exec.inspect();

  return {
    exitCode: info.ExitCode ?? 0,
    stdout,
    stderr,
    executedAt,
  };
}
