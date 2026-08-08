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

import { useTempDb } from "./temp-db.js";
import { encrypt } from "../secrets.js";
import { updateConfig } from "../config/store.js";
import { saveGitHubIntegration } from "../db/integrations.js";
import { executeTool, findTool } from "../agent/tools/toolset.js";
import { teardownAll } from "../sandbox/workspace.js";
import type { ToolExecuteResult } from "../agent/tools/types.js";

const SESSION_ID = "ccccdddd-0000-4000-8000-000000000001";

const FIXTURE: Record<string, string> = {
  "package.json":
    '{ "name": "fixture", "scripts": { "test": "vitest run" } }\n',
  "pnpm-lock.yaml": "lockfileVersion: 9\n",
  "src/app.ts": "export const a = 1;\n",
};

const gitState = {
  dirty: true,
  unpushed: "0",
  calls: [] as string[][],
};

type ExecCb = (error: Error | null, stdout: string, stderr: string) => void;

function installGitMock(): void {
  execFileMock.mockImplementation((...fnArgs: unknown[]) => {
    const args = fnArgs[1] as string[];
    const cb = fnArgs[fnArgs.length - 1] as ExecCb;
    const stripped = [...args];
    while (stripped[0] === "-c") stripped.splice(0, 2);
    const sub = stripped[0] ?? "";
    gitState.calls.push(args);
    const ok = (stdout = ""): void => cb(null, stdout, "");
    switch (sub) {
      case "clone": {
        const dir = stripped[stripped.length - 1]!;
        // A real clone always yields .git/info (the local-exclude append
        // depends on it), so the double must too.
        mkdirSync(join(dir, ".git", "info"), { recursive: true });
        for (const [rel, content] of Object.entries(FIXTURE)) {
          mkdirSync(join(dir, rel, ".."), { recursive: true });
          writeFileSync(join(dir, rel), content);
        }
        return ok();
      }
      case "rev-parse":
        return cb(new Error("fatal: Needed a single revision"), "", "fatal");
      case "status":
        return ok(gitState.dirty ? " M src/app.ts\n" : "");
      case "commit":
        gitState.dirty = false;
        gitState.unpushed = "1";
        return ok();
      case "rev-list":
        return ok(`${gitState.unpushed}\n`);
      case "push":
        gitState.unpushed = "0";
        return ok();
      case "diff":
        return ok("src/app.ts\n");
      default:
        return ok();
    }
  });
}

const dockerState = {
  execExit: 0,
  execCmds: [] as string[][],
  imageLabels: {} as Record<string, Record<string, string>>,
};

function installDockerMock(): void {
  // Function expression: getDocker() constructs with `new`.
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
        Promise.resolve({ id: "sandbox-opr", start: () => Promise.resolve() }),
      getContainer: () => ({
        remove: () => Promise.resolve(),
        exec: (opts: { Cmd: string[] }) => {
          dockerState.execCmds.push(opts.Cmd);
          const exitCode = dockerState.execExit;
          const stream = new PassThrough();
          process.nextTick(() => {
            stream.write(Buffer.from("container exec output\n"));
            stream.end();
          });
          return Promise.resolve({
            start: () => Promise.resolve(stream),
            inspect: () => Promise.resolve({ ExitCode: exitCode }),
          });
        },
      }),
      listContainers: () => Promise.resolve([]),
    };
  });
}

interface PrState {
  open: Array<{ number: number; html_url: string; draft: boolean }>;
  rejectDraft: boolean;
  createPayloads: Array<Record<string, unknown>>;
  patchPayloads: Array<Record<string, unknown>>;
}
const prState: PrState = {
  open: [],
  rejectDraft: false,
  createPayloads: [],
  patchPayloads: [],
};

function installGitHubMock(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const json = (body: unknown, status = 200): Response =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });

      if (url.includes("/pulls?state=open")) return json(prState.open);
      if (url.includes("/pulls/") && method === "PATCH") {
        prState.patchPayloads.push(
          JSON.parse(String(init?.body)) as Record<string, unknown>,
        );
        return json({});
      }
      if (url.endsWith("/pulls") && method === "POST") {
        const payload = JSON.parse(String(init?.body)) as Record<
          string,
          unknown
        >;
        prState.createPayloads.push(payload);
        if (payload["draft"] === true && prState.rejectDraft) {
          return json(
            {
              message:
                "Draft pull requests are not supported in this repository.",
            },
            422,
          );
        }
        return json(
          {
            number: 42,
            html_url: "https://github.com/acme/api/pull/42",
            draft: payload["draft"] === true,
          },
          201,
        );
      }
      if (url.includes("/repos/acme/api")) {
        return json({ default_branch: "main" });
      }
      return json({});
    }),
  );
}

let cleanupDb: () => void;
let toolUseCounter = 0;

function runOpr(
  input: Record<string, unknown>,
  sessionId = SESSION_ID,
  toolUseId = `opr-${++toolUseCounter}`,
): Promise<ToolExecuteResult> {
  const entry = findTool("OpenPullRequest");
  if (!entry) throw new Error("OpenPullRequest missing from registry");
  return executeTool(entry, input, {
    toolCallCeilingMs: 15_000,
    sessionId,
    toolUseId,
  });
}

beforeAll(() => {
  cleanupDb = useTempDb();
  // Network detachment is covered in sandbox-workspace tests; keep this
  // PR-focused test on the open path so the mock needs no network machinery.
  updateConfig({ sandboxNetwork: "open" });
  installGitMock();
  installDockerMock();
  installGitHubMock();
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
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("OpenPullRequest", () => {
  it("pushes, creates a draft PR with the composed body, and settles the audit row", async () => {
    gitState.dirty = true;
    const result = await runOpr(
      { title: "Fix payments OOM", body: "The cache grew unbounded." },
      SESSION_ID,
      "opr-create",
    );

    expect(result.outcome).toBeUndefined();
    const outcome = result.content as {
      action: string;
      number: number;
      url: string;
      draft: boolean;
      message: string;
    };
    expect(outcome.action).toBe("created");
    expect(outcome.number).toBe(42);
    expect(outcome.draft).toBe(true);
    expect(outcome.message).toContain("draft PR #42");
    expect(gitState.calls.some((a) => a.includes("push"))).toBe(true);

    const payload = prState.createPayloads.at(-1)!;
    expect(payload["draft"]).toBe(true);
    expect(payload["base"]).toBe("main");
    const body = String(payload["body"]);
    expect(body).toContain("The cache grew unbounded.");
    expect(body).toContain("## Incident");
    expect(body).toContain("## Files changed");
    expect(body).toContain("- src/app.ts");
    // The gate is gone by design: the body carries no verification section.
    expect(body).not.toContain("## Verification");
    expect(body).toContain(SESSION_ID);
  });

  it("updates the existing open PR on a later call instead of duplicating", async () => {
    prState.open = [
      {
        number: 42,
        html_url: "https://github.com/acme/api/pull/42",
        draft: true,
      },
    ];
    gitState.dirty = true;
    const before = prState.createPayloads.length;

    const result = await runOpr(
      { title: "Fix payments OOM (v2)" },
      SESSION_ID,
      "opr-update",
    );
    prState.open = [];

    expect(result.outcome).toBeUndefined();
    const outcome = result.content as { action: string; message: string };
    expect(outcome.action).toBe("updated");
    expect(outcome.message).toContain("Updated existing PR #42");
    expect(prState.createPayloads).toHaveLength(before);
    expect(prState.patchPayloads.at(-1)?.["title"]).toBe(
      "Fix payments OOM (v2)",
    );
  });

  it("falls back to a regular PR when the plan rejects drafts, and says so", async () => {
    prState.rejectDraft = true;
    gitState.dirty = true;
    const result = await runOpr(
      { title: "Fix it" },
      SESSION_ID,
      "opr-fallback",
    );
    prState.rejectDraft = false;

    expect(result.outcome).toBeUndefined();
    const outcome = result.content as { draft: boolean; message: string };
    expect(outcome.draft).toBe(false);
    expect(outcome.message).toContain("draft mode is unavailable");
    const attempts = prState.createPayloads.slice(-2);
    expect(attempts[0]?.["draft"]).toBe(true);
    expect(attempts[1]?.["draft"]).toBe(false);
  });

  it("says there is nothing to propose, without asking GitHub, when the branch has no commits", async () => {
    // GitHub answers an empty diff with a bare 422, which reads as a broken
    // token; the operator then reconnects a credential that was working.
    gitState.dirty = false;
    gitState.unpushed = "0";
    gitState.calls.length = 0;
    const requestsBefore = prState.createPayloads.length;

    const result = await runOpr({ title: "Fix it" }, SESSION_ID, "opr-nodiff");

    expect(result.outcome).toBe("expected_miss");
    const outcome = result.content as { action: string; message: string };
    expect(outcome.action).toBe("nothing_to_propose");
    expect(outcome.message).toContain("nothing to propose");
    expect(prState.createPayloads).toHaveLength(requestsBefore);
    expect(gitState.calls.some((a) => a.includes("push"))).toBe(false);
  });

  // Crash recovery is branch identity, not a stored attempt: a retry finds the
  // PR its own branch already opened and updates it, so a run that died after
  // creating one cannot open a second.
  it("updates rather than duplicating when a retry follows a PR it already opened", async () => {
    prState.open = [
      {
        number: 42,
        html_url: "https://github.com/acme/api/pull/42",
        draft: true,
      },
    ];
    gitState.dirty = true;
    const before = prState.createPayloads.length;

    const result = await runOpr(
      { title: "Fix it again" },
      SESSION_ID,
      "opr-crash",
    );
    prState.open = [];

    expect((result.content as { action: string }).action).toBe("updated");
    expect(prState.createPayloads).toHaveLength(before);
  });
});
