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
import { encrypt } from "../config/crypto.js";
import { updateConfig } from "../config/store.js";
import {
  deleteGitHubIntegration,
  saveGitHubIntegration,
} from "../db/integrations.js";
import { hasPendingHumanInput } from "../db/interrupts.js";
import { runInvestigation } from "../agent/loop.js";
import {
  effectiveToolset,
  executeTool,
  findTool,
} from "../agent/tools/toolset.js";
import { REPO_TOOL_NAMES } from "../agent/tools/repo.js";
import { teardownAll } from "../sandbox/workspace.js";
import type { Tool, ToolExecuteContext } from "../agent/tools/types.js";
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
const CTX: ToolExecuteContext = {
  toolTimeoutMs: 15_000,
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
): Promise<{ content: unknown; is_error?: boolean }> {
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
    const withRepo = effectiveToolset(undefined, true, { github: true }).map(
      (t) => t.schema.name,
    );
    const withoutRepo = effectiveToolset(undefined, true, {
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
      expect(result.is_error).toBe(true);
      expect(String(result.content)).toContain("Integrations page");
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
    expect(read.is_error).toBeUndefined();
    expect(String(read.content)).toContain("1\tconst a = 1;");

    const edit = await run("Edit", {
      path: "src/app.ts",
      old_string: "const a = 1;",
      new_string: "const a = 42;",
    });
    expect(edit.is_error).toBeUndefined();
    const change = edit.content as { path: string; hunks: DiffHunk[] };
    expect(change.path).toBe("src/app.ts");
    const lines = change.hunks.flatMap((h) => h.lines);
    expect(lines).toContainEqual(
      expect.objectContaining({ type: "removed", content: "const a = 1;" }),
    );
    expect(lines).toContainEqual(
      expect.objectContaining({ type: "added", content: "const a = 42;" }),
    );
  });

  it("refuses to edit a file that was never read", async () => {
    const result = await run("Edit", {
      path: "package.json",
      old_string: "fixture",
      new_string: "renamed",
    });
    expect(result.is_error).toBe(true);
    expect(String(result.content)).toContain("Read");
  });

  it("fails loudly on a non-unique old_string and honours replace_all", async () => {
    const ambiguous = await run("Edit", {
      path: "src/app.ts",
      old_string: '"OLD"',
      new_string: '"NEW"',
    });
    expect(ambiguous.is_error).toBe(true);
    expect(String(ambiguous.content)).toContain("replace_all");

    const all = await run("Edit", {
      path: "src/app.ts",
      old_string: '"OLD"',
      new_string: '"NEW"',
      replace_all: true,
    });
    expect(all.is_error).toBeUndefined();
    const allLines = (all.content as { hunks: DiffHunk[] }).hunks.flatMap(
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
    expect(created.is_error).toBeUndefined();
    const createdLines = (
      created.content as { hunks: DiffHunk[] }
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
    expect(overwrite.is_error).toBe(true);
    expect(String(overwrite.content)).toContain("Read");
  });

  it("rejects paths that escape the repository", async () => {
    const result = await run("Read", { path: "../../etc/passwd" });
    expect(result.is_error).toBe(true);
    expect(String(result.content)).toContain("escapes the repository");
  });

  it("the first Bash result opens with the provision-time install note, later ones don't", async () => {
    // This fixture has no lockfile, so the note is the honest skip variant.
    const first = await run("Bash", { command: "echo one" });
    expect(first.is_error).toBeUndefined();
    const firstOut = (first.content as { output: string }).output;
    expect(firstOut).toContain("No Node lockfile");
    expect(firstOut).toContain("ok output");

    const second = await run("Bash", { command: "echo two" });
    expect((second.content as { output: string }).output).not.toContain(
      "No Node lockfile",
    );
  });

  it("execs in the container with the per-tool timeout, not the 15s default", async () => {
    const result = await run("Bash", { command: "pnpm test" });
    expect(result.is_error).toBeUndefined();
    const outcome = result.content as { exitCode: number; output: string };
    expect(outcome.exitCode).toBe(0);
    expect(outcome.output).toContain("ok output");

    const cmd = dockerState.execCmds.at(-1)!;
    // coreutils timeout enforces the 300s per-tool value inside the container.
    expect(cmd.slice(0, 2)).toEqual(["timeout", "300"]);
    expect(cmd).toContain("pnpm test");
  });

  it("rejects a cwd that escapes and re-roots a valid one at /workspace", async () => {
    const escape = await run("Bash", { command: "ls", cwd: "../.." });
    expect(escape.is_error).toBe(true);

    const scoped = await run("Bash", { command: "ls", cwd: "src" });
    expect(scoped.is_error).toBeUndefined();
    expect(dockerState.execCwds.at(-1)).toBe("/workspace/src");
  });
});

describe("code-session budget extension", () => {
  it("a repo tool call extends the deadline past the investigation budget", async () => {
    const gates = createGateController();
    mockCreateProvider.mockImplementation(() =>
      scriptRunner.create({ gate: gates.gate }),
    );
    updateConfig({ hardTimeoutMs: 300, codeSessionBudgetMs: 1_200_000 });
    scriptRunner.setScript([
      {
        toolUses: [{ id: "t1", name: "Read", input: { path: "src/app.ts" } }],
        text: "",
      },
      { toolUses: [], text: "Done." },
    ]);

    const sessionId = "aaaabbbb-0000-4000-8000-00000000ea01";
    const run = runInvestigation({ sessionId, userMessage: "fix the repo" });
    // Park turn 1 until the original 300ms deadline has passed: only the
    // repo-tool extension can keep the loop alive beyond it.
    await new Promise((r) => setTimeout(r, 400));
    gates.releaseNext();
    // Give turn 1's tool time to execute and turn 2 time to park at the gate.
    await new Promise((r) => setTimeout(r, 150));
    gates.releaseAll();
    await run;

    expect(hasPendingHumanInput(sessionId)).toBe(false);
  });

  it("without a repo tool the same timing suspends with a continue request", async () => {
    const gates = createGateController();
    mockCreateProvider.mockImplementation(() =>
      scriptRunner.create({ gate: gates.gate }),
    );
    updateConfig({ hardTimeoutMs: 300, codeSessionBudgetMs: 1_200_000 });
    scriptRunner.setScript([
      {
        toolUses: [{ id: "t1", name: "nonexistent_tool", input: {} }],
        text: "",
      },
      { toolUses: [], text: "Done." },
    ]);

    const sessionId = "aaaabbbb-0000-4000-8000-00000000ea02";
    const run = runInvestigation({ sessionId, userMessage: "look around" });
    await new Promise((r) => setTimeout(r, 400));
    gates.releaseNext();
    gates.releaseAll();
    await run;

    expect(hasPendingHumanInput(sessionId)).toBe(true);
  });
});
