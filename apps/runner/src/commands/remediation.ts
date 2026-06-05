import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  ExecCommandInput,
  ExecCommandResult,
  RestartContainerInput,
  RestartContainerResult,
  RollbackDeployInput,
  RollbackDeployResult,
} from "@nightwatch/shared";

const exec = promisify(execFile);

export async function restartContainer(
  input: RestartContainerInput,
): Promise<RestartContainerResult> {
  const startedAt = new Date().toISOString();

  const { stdout: inspectBefore } = await exec("docker", [
    "inspect",
    input.containerName,
  ]);
  const before = (
    JSON.parse(inspectBefore) as Array<Record<string, unknown>>
  )[0];
  const stateBefore = before?.["State"] as Record<string, unknown> | undefined;
  const previousExitCode = Number(stateBefore?.["ExitCode"] ?? 0);

  if (input.delaySeconds && input.delaySeconds > 0) {
    await new Promise((r) => setTimeout(r, input.delaySeconds! * 1000));
  }

  await exec("docker", ["restart", input.containerName]);

  const { stdout: inspectAfter } = await exec("docker", [
    "inspect",
    input.containerName,
  ]);
  const after = (JSON.parse(inspectAfter) as Array<Record<string, unknown>>)[0];
  const stateAfter = after?.["State"] as Record<string, unknown> | undefined;
  const newStatus = String(stateAfter?.["Status"] ?? "unknown");

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

  const { stdout, stderr } = await exec("docker", [
    "exec",
    input.containerName,
    cmd,
    ...args,
  ]).catch(
    (
      err: NodeJS.ErrnoException & {
        code?: number;
        stdout?: string;
        stderr?: string;
      },
    ) => ({
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? String(err.message),
      code: err.code,
    }),
  );

  return {
    exitCode: 0,
    stdout: String(stdout),
    stderr: String(stderr),
    executedAt,
  };
}
