import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { execFileMock, MockDocker } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  MockDocker: vi.fn(),
}));
vi.mock("node:child_process", () => ({ execFile: execFileMock }));
vi.mock("dockerode", () => ({ default: MockDocker }));
vi.mock("../llm/factory.js", () => import("./llm-factory-mock.js"));

import { mockCreateProvider } from "./llm-factory-mock.js";

import {
  createGateController,
  createScriptRunner,
} from "./contract-fake-provider.js";
import { useTempDb } from "./temp-db.js";
import { encrypt } from "../secrets.js";
import { updateConfig } from "../config/store.js";
import {
  deleteGitHubIntegration,
  saveGitHubIntegration,
} from "../db/integrations.js";
import { hasPendingHumanInput } from "../db/interrupts.js";
import { runSession } from "../agent/loop.js";
import {
  effectiveToolset,
  executeTool,
  findTool,
} from "../agent/tools/toolset.js";
import { REPO_TOOL_NAMES } from "../agent/tools/repo.js";
import { teardownAll } from "../sandbox/workspace.js";
import { parsedContent } from "./tool-result.js";
import type {
  Tool,
  ToolDispatchContext,
  DispatchedToolResult,
} from "../agent/tools/types.js";
import type { DiffHunk } from "../sandbox/tools/diff.js";

const scriptRunner = createScriptRunner();
mockCreateProvider.mockImplementation(() => scriptRunner.create());

// The clone double materializes a fixture checkout, honouring what a real
// clone produces: files on disk in the target directory.
const FIXTURE_FILES: Record<string, string> = {
  "src/app.ts": 'const a = 1;\nconst target = "OLD";\nconst b = "OLD";\n',
  "package.json": '{ "name": "fixture" }\n',
};

type ExecCb = (error: Error | null, stdout: string, stderr: string) => void;

function installGitMock(): void {
  execFileMock.mockImplementation((...fnArgs: unknown[]) => {
    const args = fnArgs[1] as string[];
    const cb = fnArgs[fnArgs.length - 1] as ExecCb;
    const stripped = [...args];
    while (stripped[0] === "-c") stripped.splice(0, 2);
    const sub = stripped[0] ?? "";
    const ok = (stdout = ""): void => cb(null, stdout, "");
    switch (sub) {
      case "clone": {
        const dir = stripped[stripped.length - 1]!;
        // A real clone always yields .git/info (the local-exclude append
        // depends on it), so the double must too.
        mkdirSync(join(dir, ".git", "info"), { recursive: true });
        for (const [rel, content] of Object.entries(FIXTURE_FILES)) {
          mkdirSync(join(dir, rel, ".."), { recursive: true });
          writeFileSync(join(dir, rel), content);
        }
        return ok();
      }
      case "rev-parse":
        return cb(new Error("fatal: Needed a single revision"), "", "fatal");
      case "status":
        return ok("");
      case "rev-list":
        return ok("0\n");
      default:
        return ok();
    }
  });
}

const dockerState = {
  execCmds: [] as string[][],
  execCwds: [] as Array<string | undefined>,
  imageLabels: {} as Record<string, Record<string, string>>,
};

function installDockerMock(): void {
  // Function expression: getDocker() constructs with `new`, and a constructor
  // returning an object yields that object.
  MockDocker.mockImplementation(function () {
    return {
      ping: () => Promise.resolve({}),
      getImage: (name: string) => ({
        inspect: () =>
          dockerState.imageLabels[name]
            ? Promise.resolve({
                Config: { Labels: dockerState.imageLabels[name] },
              })
            : Promise.reject(new Error("no such image")),
      }),
      buildImage: (
        _ctx: unknown,
        opts: { t: string; labels?: Record<string, string> },
      ) => {
        dockerState.imageLabels[opts.t] = opts.labels ?? {};
        return Promise.resolve({});
      },
      modem: {
        followProgress: (
          _stream: unknown,
          cb: (err: Error | null, events: unknown[]) => void,
        ) => cb(null, []),
      },
      createContainer: () =>
        Promise.resolve({ id: "sandbox-1", start: () => Promise.resolve() }),
      getContainer: () => ({
        remove: () => Promise.resolve(),
        exec: (opts: { Cmd: string[]; WorkingDir?: string }) => {
          dockerState.execCmds.push(opts.Cmd);
          dockerState.execCwds.push(opts.WorkingDir);
          const stream = new PassThrough();
          process.nextTick(() => {
            stream.write(Buffer.from("ok output\n"));
            stream.end();
          });
          return Promise.resolve({
            start: () => Promise.resolve(stream),
            inspect: () => Promise.resolve({ ExitCode: 0 }),
          });
        },
      }),
      listContainers: () => Promise.resolve([]),
    };
  });
}

const SESSION_ID = "aaaabbbb-0000-4000-8000-000000000001";
// The ceiling the operator allows, which a tool's own lower limit narrows.
const CTX: ToolDispatchContext = {
  toolCallCeilingMs: 600_000,
  sessionId: SESSION_ID,
  toolUseId: "static",
};

function tool(name: string): Tool {
  const entry = findTool(name);
  if (!entry) throw new Error(`tool ${name} missing from registry`);
  return entry;
}

async function run(
  name: string,
  input: Record<string, unknown>,
): Promise<DispatchedToolResult> {
  return executeTool(tool(name), input, CTX);
}

let cleanupDb: () => void;

beforeAll(() => {
  cleanupDb = useTempDb();
  // Network detachment is exercised in sandbox-workspace tests; keep these
  // tool tests on the open path so the mock needs no network machinery.
  updateConfig({ sandboxNetwork: "open" });
  installGitMock();
  installDockerMock();
  saveGitHubIntegration({
    tokenEncrypted: encrypt("github_pat_fixture"),
    repoOwner: "acme",
    repoName: "api",
    tokenExpiresAt: null,
  });
});

afterAll(async () => {
  await teardownAll("test cleanup");
  cleanupDb();
  vi.unstubAllEnvs();
});

describe("offering gate", () => {
  it("strips every repo tool when no integration is configured", () => {
    const withRepo = effectiveToolset(undefined, { github: true }).map(
      (t) => t.schema.name,
    );
    const withoutRepo = effectiveToolset(undefined, {
      github: false,
    }).map((t) => t.schema.name);
    for (const name of REPO_TOOL_NAMES) {
      expect(withRepo).toContain(name);
      expect(withoutRepo).not.toContain(name);
    }
  });
});

describe("repo tools through registry dispatch", () => {
  it("returns a corrective error when the integration is missing", async () => {
    deleteGitHubIntegration();
    try {
      const result = await run("Read", { path: "src/app.ts" });
      expect(result.outcome).toBe("permission");
      expect(result.content).toContain("Integrations page");
    } finally {
      saveGitHubIntegration({
        tokenEncrypted: encrypt("github_pat_fixture"),
        repoOwner: "acme",
        repoName: "api",
        tokenExpiresAt: null,
      });
    }
  });

  it("reads a file as numbered lines and unlocks editing it", async () => {
    const read = await run("Read", { path: "src/app.ts" });
    expect(read.outcome).toBeUndefined();
    expect(read.content).toContain("1\tconst a = 1;");

    const edit = await run("Edit", {
      path: "src/app.ts",
      old_string: "const a = 1;",
      new_string: "const a = 42;",
    });
    expect(edit.outcome).toBeUndefined();
    const change = parsedContent<{ path: string; hunks: DiffHunk[] }>(edit);
    expect(change.path).toBe("src/app.ts");
    const lines = change.hunks.flatMap((h) => h.lines);
    expect(lines).toContainEqual(
      expect.objectContaining({ type: "removed", content: "const a = 1;" }),
    );
    expect(lines).toContainEqual(
      expect.objectContaining({ type: "added", content: "const a = 42;" }),
    );
  });

  it("reads a file that is not there as a miss, not as a fault", async () => {
    // The canonical case: docker-compose.yml when the repo has .yaml. The tool
    // worked, so this must not render in the same red as a crashed tool.
    const result = await run("Read", { path: "docker-compose.yml" });

    expect(result.outcome).toBe("expected_miss");
    expect(result.content).toContain("File not found");
  });

  it("refuses to edit a file that was never read", async () => {
    const result = await run("Edit", {
      path: "package.json",
      old_string: "fixture",
      new_string: "renamed",
    });
    expect(result.outcome).toBe("system");
    expect(result.content).toContain("Read");
  });

  it("fails loudly on a non-unique old_string and honours replace_all", async () => {
    const ambiguous = await run("Edit", {
      path: "src/app.ts",
      old_string: '"OLD"',
      new_string: '"NEW"',
    });
    expect(ambiguous.outcome).toBe("system");
    expect(ambiguous.content).toContain("replace_all");

    const all = await run("Edit", {
      path: "src/app.ts",
      old_string: '"OLD"',
      new_string: '"NEW"',
      replace_all: true,
    });
    expect(all.outcome).toBeUndefined();
    const allLines = parsedContent<{ hunks: DiffHunk[] }>(all).hunks.flatMap(
      (h) => h.lines,
    );
    expect(allLines).toContainEqual(
      expect.objectContaining({
        type: "added",
        content: 'const target = "NEW";',
      }),
    );
  });

  it("creates new files freely but refuses to overwrite an unread one", async () => {
    const created = await run("Write", {
      path: "docs/new-note.md",
      content: "hello\n",
    });
    expect(created.outcome).toBeUndefined();
    const createdLines = parsedContent<{ hunks: DiffHunk[] }>(
      created,
    ).hunks.flatMap((h) => h.lines);
    expect(createdLines.length).toBeGreaterThan(0);
    expect(
      createdLines.every((l) => l.type === "added" && l.oldLineNumber === null),
    ).toBe(true);
    expect(createdLines.some((l) => l.content === "hello")).toBe(true);

    const overwrite = await run("Write", {
      path: "package.json",
      content: "{}\n",
    });
    expect(overwrite.outcome).toBe("system");
    expect(overwrite.content).toContain("Read");
  });

  it("rejects paths that escape the repository", async () => {
    const result = await run("Read", { path: "../../etc/passwd" });
    expect(result.outcome).toBe("system");
    expect(result.content).toContain("escapes the repository");
  });

  it("the first Bash result opens with the provision-time install note, later ones don't", async () => {
    // This fixture has no lockfile, so the note is the honest skip variant.
    const first = await run("Bash", { command: "echo one" });
    expect(first.outcome).toBeUndefined();
    const firstOut = parsedContent<{ output: string }>(first).output;
    expect(firstOut).toContain("No Node lockfile");
    expect(firstOut).toContain("ok output");

    const second = await run("Bash", { command: "echo two" });
    expect(parsedContent<{ output: string }>(second).output).not.toContain(
      "No Node lockfile",
    );
  });

  it("execs in the container with its own timeout when that is under the ceiling", async () => {
    const result = await run("Bash", { command: "pnpm test" });
    expect(result.outcome).toBeUndefined();
    const outcome = parsedContent<{ exitCode: number; output: string }>(result);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.output).toContain("ok output");

    const cmd = dockerState.execCmds.at(-1)!;
    // coreutils timeout enforces the 300s per-tool value inside the container.
    expect(cmd.slice(0, 2)).toEqual(["timeout", "300"]);
    expect(cmd).toContain("pnpm test");
  });

  it("is cut down to the ceiling when the operator allows less than the tool wants", async () => {
    // The ceiling is the operator's brake: a tool can narrow it, never raise it.
    await executeTool(
      tool("Bash"),
      { command: "pnpm test" },
      {
        ...CTX,
        toolCallCeilingMs: 20_000,
      },
    );

    expect(dockerState.execCmds.at(-1)?.slice(0, 2)).toEqual(["timeout", "20"]);
  });

  it("rejects a cwd that escapes and re-roots a valid one at /workspace", async () => {
    const escape = await run("Bash", { command: "ls", cwd: "../.." });
    expect(escape.outcome).toBe("system");

    const scoped = await run("Bash", { command: "ls", cwd: "src" });
    expect(scoped.outcome).toBeUndefined();
    expect(dockerState.execCwds.at(-1)).toBe("/workspace/src");
  });
});

// Repo work spends the same budget as anything else: touching a repo tool buys
// no extra time, so a code session reaches the check-in like every other run.
describe("repo work and the time budget", () => {
  async function runPastTheBudget(
    sessionId: string,
    toolName: string,
  ): Promise<void> {
    const gates = createGateController();
    mockCreateProvider.mockImplementation(() =>
      scriptRunner.create({ gate: gates.gate }),
    );
    updateConfig({ checkInAfterMs: 300 });
    scriptRunner.setScript([
      {
        toolUses: [{ id: "t1", name: toolName, input: { path: "src/app.ts" } }],
        text: "",
      },
      { toolUses: [], text: "Done." },
    ]);

    const run = runSession({ sessionId, userMessage: "fix the repo" });
    // Park turn 1 until the deadline has passed.
    await new Promise((r) => setTimeout(r, 400));
    gates.releaseNext();
    await new Promise((r) => setTimeout(r, 150));
    gates.releaseAll();
    await run;
  }

  it("a repo tool call does not buy the run more time", async () => {
    const sessionId = "aaaabbbb-0000-4000-8000-00000000ea01";

    await runPastTheBudget(sessionId, "Read");

    expect(hasPendingHumanInput(sessionId)).toBe(true);
  });

  it("which is the same answer any other tool gets", async () => {
    const sessionId = "aaaabbbb-0000-4000-8000-00000000ea02";

    await runPastTheBudget(sessionId, "nonexistent_tool");

    expect(hasPendingHumanInput(sessionId)).toBe(true);
  });
});
