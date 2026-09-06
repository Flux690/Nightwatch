import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedAlertSession } from "./session-helper.js";
import type { NormalizedAlert } from "@nightwarden/shared";
import { useTempDb } from "./temp-db.js";
import { saveSentryIntegration } from "../integrations/store.js";
import { executeTool, findTool } from "../agent/tools/toolset.js";
import { parsedContent } from "./tool-result.js";
import { relativeToAlert } from "../agent/tools/sentry.js";
import type {
  SentryEventResult,
  SentryIssuesResult,
  SentryReleasesResult,
} from "../agent/tools/sentry.js";
import type { Tool, ToolDispatchContext } from "../agent/tools/types.js";

const FIRED_AT = "2026-07-16T12:00:00.000Z";

const ALERT: NormalizedAlert = {
  sourceAlertId: "alert-1",
  labels: {},
  alertType: "OOMKill",
  firedAt: FIRED_AT,
  annotations: {},
  generatorURL: null,
  values: {},
};

interface SentryMock {
  requests: Array<{
    path: string;
    params: URLSearchParams;
    authorization: string | undefined;
  }>;
  issues: unknown[];
  event: Record<string, unknown>;
  tagValues: unknown[];
  releases: unknown[];
  commits: unknown[];
  link: string | null;
  status: number;
  // The whole body, for a payload that is not the list Sentry documents.
  body?: unknown;
}

function makeMock(): SentryMock {
  return {
    requests: [],
    issues: [],
    event: {},
    tagValues: [],
    releases: [],
    commits: [],
    link: null,
    status: 200,
  };
}

function installSentryMock(mock: SentryMock): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
      const parsed = new URL(String(input));
      const headers = (init?.headers ?? {}) as Record<string, string>;
      mock.requests.push({
        path: parsed.pathname,
        params: parsed.searchParams,
        authorization: headers["Authorization"],
      });

      if (mock.status !== 200) {
        return new Response("nope", { status: mock.status });
      }
      const body =
        mock.body !== undefined
          ? mock.body
          : parsed.pathname.endsWith("/commits/")
            ? mock.commits
            : parsed.pathname.includes("/releases/")
              ? mock.releases
              : parsed.pathname.endsWith("/values/")
                ? mock.tagValues
                : parsed.pathname.includes("/events/latest/")
                  ? mock.event
                  : mock.issues;

      return new Response(JSON.stringify(body), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          ...(mock.link !== null && { Link: mock.link }),
        },
      });
    }),
  );
}

describe("Sentry tools through the tool dispatch", () => {
  let cleanupDb: () => void;
  let search: Tool;
  let event: Tool;
  let tagValues: Tool;
  let releases: Tool;
  let commits: Tool;
  let mock: SentryMock;
  let sessionSeq = 0;

  async function toolContext(
    alert: NormalizedAlert | null,
  ): Promise<ToolDispatchContext> {
    sessionSeq++;
    const sessionId = `sentry-tools-${sessionSeq}`;
    await seedAlertSession(
      { sessionId, title: "test", createdAt: new Date().toISOString() },
      alert ? [alert] : [],
    );
    return {
      toolCallCeilingMs: 30_000,
      sessionId,
      toolCallId: `tu-${sessionSeq}`,
    };
  }

  async function connect(): Promise<void> {
    await saveSentryIntegration({
      baseUrl: "https://sentry.internal/",
      orgSlug: "acme",
      token: "sntrys_secret",
    });
  }

  beforeEach(async () => {
    cleanupDb = await useTempDb();
    mock = makeMock();
    installSentryMock(mock);
    search = findTool("SearchSentryIssues")!;
    event = findTool("GetSentryLatestEvent")!;
    tagValues = findTool("GetSentryIssueTagValues")!;
    releases = findTool("GetSentryReleases")!;
    commits = findTool("GetSentryReleaseCommits")!;
  });

  afterEach(() => {
    cleanupDb();
    vi.unstubAllGlobals();
  });

  it("returns a corrective error without any request when not configured", async () => {
    const result = await executeTool(search, {}, await toolContext(ALERT));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not configured");
    expect(mock.requests).toHaveLength(0);
  });

  describe("relativeToAlert", () => {
    const anchor = new Date(FIRED_AT);
    const at = (minutes: number): Date =>
      new Date(anchor.getTime() + minutes * 60_000);

    it.each([
      [at(-134), "2h 14m before the alert fired"],
      [at(-5), "5m before the alert fired"],
      [at(20), "20m after the alert fired"],
      [at(-43_200), "30d before the alert fired"],
      [at(1_565), "1d 2h 5m after the alert fired"],
      [at(0), "under a minute before the alert fired"],
    ])("reads %s as %s", (moment, expected) => {
      expect(relativeToAlert(moment, anchor)).toBe(expected);
    });
  });

  describe("with Sentry connected", () => {
    beforeEach(connect);

    describe("SearchSentryIssues", () => {
      it("addresses the org, anchors on firedAt, and never sends statsPeriod", async () => {
        await executeTool(
          search,
          { projects: ["api", "web"], environments: ["production"] },
          await toolContext(ALERT),
        );

        const req = mock.requests[0]!;
        expect(req.path).toBe("/api/0/organizations/acme/issues/");
        expect(req.authorization).toBe("Bearer sntrys_secret");
        expect(req.params.getAll("project")).toEqual(["api", "web"]);
        expect(req.params.getAll("environment")).toEqual(["production"]);
        expect(req.params.get("sort")).toBe("freq");
        // statsPeriod would override start and end, discarding the alert anchor.
        expect(req.params.get("statsPeriod")).toBeNull();
        expect(req.params.get("start")).toBe(
          new Date(Date.parse(FIRED_AT) - 60 * 60_000).toISOString(),
        );
        expect(req.params.get("end")).toBe(
          new Date(Date.parse(FIRED_AT) + 5 * 60_000).toISOString(),
        );
      });

      it("always sends query, so Sentry's is:unresolved default never hides a resolved issue", async () => {
        await executeTool(search, {}, await toolContext(ALERT));
        expect(mock.requests[0]!.params.get("query")).toBe("");

        await executeTool(
          search,
          { query: "level:error" },
          await toolContext(ALERT),
        );
        expect(mock.requests[1]!.params.get("query")).toBe("level:error");
      });

      it("keeps the lifetime count and the windowed counts apart, and carries the project slug", async () => {
        mock.issues = [
          {
            id: "77",
            shortId: "API-9",
            title: "TypeError",
            culprit: "handlers.checkout",
            level: "error",
            count: "1500",
            userCount: 40,
            filtered: {
              count: "12",
              userCount: 3,
              firstSeen: FIRED_AT,
              lastSeen: FIRED_AT,
            },
            project: { slug: "api", name: "API" },
          },
        ];
        const result = await executeTool(search, {}, await toolContext(ALERT));
        const body = parsedContent<SentryIssuesResult>(result);

        const issue = body.issues[0]!;
        expect(issue.count).toBe("1500");
        expect(issue.inWindow?.count).toBe("12");
        expect(issue.project).toBe("api");
        expect(body.note).toContain("inWindow");
      });

      it("names what it searched, and reads an empty page as an expected miss", async () => {
        const result = await executeTool(search, {}, await toolContext(ALERT));
        const body = parsedContent<SentryIssuesResult>(result);

        expect(result.isError).toBeUndefined();
        expect(body.projectsSearched).toBe("every project the token can reach");
        expect(body.environmentsSearched).toBe("every environment");
        expect(body.note).toContain("not that the service threw nothing");
      });

      it("hands back the cursor Sentry offers, and none when the next page holds nothing", async () => {
        mock.issues = [{ id: "1" }];
        mock.link =
          '<https://sentry.internal/x?cursor=0:100:0>; rel="next"; results="true"; cursor="0:100:0"';
        const withMore = await executeTool(
          search,
          {},
          await toolContext(ALERT),
        );
        expect(parsedContent<SentryIssuesResult>(withMore).nextCursor).toBe(
          "0:100:0",
        );

        mock.link =
          '<https://sentry.internal/x?cursor=0:100:0>; rel="next"; results="false"; cursor="0:100:0"';
        const lastPage = await executeTool(
          search,
          {},
          await toolContext(ALERT),
        );
        expect(
          parsedContent<SentryIssuesResult>(lastPage).nextCursor,
        ).toBeNull();
      });
    });

    describe("GetSentryLatestEvent", () => {
      it("asks for the latest event and carries the release object through whole", async () => {
        mock.event = {
          eventID: "abc",
          title: "TypeError",
          release: {
            version: "api@1.4.2",
            dateReleased: FIRED_AT,
            lastDeploy: { dateFinished: FIRED_AT, environment: "production" },
          },
          tags: [{ key: "server_name", value: "web-01" }],
          formatted: "# TypeError\n\nstack here",
        };
        const result = await executeTool(
          event,
          { issueId: "77" },
          await toolContext(ALERT),
        );
        const body = parsedContent<SentryEventResult>(result);

        expect(mock.requests[0]!.path).toBe(
          "/api/0/organizations/acme/issues/77/events/latest/",
        );
        // Verbatim: trimming it would break the match against an image tag.
        expect(body.release?.version).toBe("api@1.4.2");
        expect(body.release?.lastDeploy).toEqual({
          dateFinished: FIRED_AT,
          environment: "production",
        });
        expect(body.formatted).toBe("# TypeError\n\nstack here");
        expect(body.entries).toBeUndefined();
      });

      it("drops vendor frames and counts them when Sentry renders nothing for us", async () => {
        mock.event = {
          eventID: "abc",
          entries: [
            {
              type: "exception",
              data: {
                values: [
                  {
                    stacktrace: {
                      frames: [
                        { function: "node_modules/express", inApp: false },
                        { function: "handlers.checkout", inApp: true },
                        { function: "node_modules/pg", inApp: false },
                      ],
                    },
                  },
                ],
              },
            },
          ],
        };
        const result = await executeTool(
          event,
          { issueId: "77" },
          await toolContext(ALERT),
        );
        const body = parsedContent<SentryEventResult>(result);

        expect(body.formatted).toBeUndefined();
        expect(body.vendorFramesDropped).toBe(2);
        expect(JSON.stringify(body.entries)).toContain("handlers.checkout");
        expect(JSON.stringify(body.entries)).not.toContain("node_modules/pg");
        // This event carries no release either, which the result has to say.
        expect(body.release).toBeNull();
        expect(body.note).toContain("no release");
      });

      it("keeps every frame when the SDK marked none of them as in-app", async () => {
        mock.event = {
          entries: [
            {
              type: "exception",
              data: {
                values: [{ stacktrace: { frames: [{ function: "main" }] } }],
              },
            },
          ],
        };
        const result = await executeTool(
          event,
          { issueId: "77" },
          await toolContext(ALERT),
        );
        const body = parsedContent<SentryEventResult>(result);

        expect(body.vendorFramesDropped).toBe(0);
        expect(JSON.stringify(body.entries)).toContain("main");
      });
    });

    describe("GetSentryIssueTagValues", () => {
      it("states that the distribution covers the whole issue, not the alert window", async () => {
        mock.tagValues = [
          {
            value: "web-01",
            count: 12,
            firstSeen: FIRED_AT,
            lastSeen: FIRED_AT,
          },
        ];
        const result = await executeTool(
          tagValues,
          { issueId: "77", key: "server_name" },
          await toolContext(ALERT),
        );
        const body = parsedContent<{ note: string; values: unknown[] }>(result);

        expect(mock.requests[0]!.path).toBe(
          "/api/0/organizations/acme/issues/77/tags/server_name/values/",
        );
        // Sentry accepts no time range here, so a windowed reading would be false.
        expect(mock.requests[0]!.params.get("start")).toBeNull();
        expect(body.note).toContain("whole life of the issue");
        expect(body.values).toHaveLength(1);
      });
    });

    describe("GetSentryReleases", () => {
      it("annotates every release against the alert and drops none of them", async () => {
        mock.releases = [
          {
            version: "api@1.4.2",
            // dateReleased sits at the alert, so a 2h 14m reading proves the
            // finished deploy is what dates a release.
            dateReleased: FIRED_AT,
            lastDeploy: {
              dateFinished: new Date(
                Date.parse(FIRED_AT) - 134 * 60_000,
              ).toISOString(),
            },
            newGroups: 3,
          },
          {
            version: "api@1.0.0",
            dateCreated: new Date(
              Date.parse(FIRED_AT) - 30 * 86_400_000,
            ).toISOString(),
          },
          { version: "api@0.9.0" },
        ];
        const result = await executeTool(
          releases,
          {},
          await toolContext(ALERT),
        );
        const body = parsedContent<SentryReleasesResult>(result);

        expect(mock.requests[0]!.path).toBe(
          "/api/0/organizations/acme/releases/",
        );
        // A release a month old still ships: a leak can predate the alert.
        expect(body.releases).toHaveLength(3);
        expect(body.releases[0]!.relativeToAlert).toBe(
          "2h 14m before the alert fired",
        );
        expect(body.releases[1]!.relativeToAlert).toBe(
          "30d before the alert fired",
        );
        expect(body.releases[2]!.relativeToAlert).toBeNull();
        expect(body.note).toContain("is unknown");
        expect(body.releases[0]!.newGroups).toBe(3);
        expect(body.alertFiredAt).toBe(FIRED_AT);
      });
    });

    describe("GetSentryReleaseCommits", () => {
      it("carries the suspect marker and the pull request through", async () => {
        mock.commits = [
          {
            id: "abc123",
            message: "raise the pool size",
            author: { name: "A Dev" },
            repository: { name: "acme/api" },
            pullRequest: { id: "42" },
            suspectCommitType: "via SCM integration",
          },
        ];
        const result = await executeTool(
          commits,
          { version: "api@1.4.2" },
          await toolContext(ALERT),
        );
        const body = parsedContent<{
          commits: Array<{ suspectCommitType: string; repository: string }>;
        }>(result);

        expect(mock.requests[0]!.path).toBe(
          "/api/0/organizations/acme/releases/api%401.4.2/commits/",
        );
        expect(body.commits[0]!.suspectCommitType).toBe("via SCM integration");
        expect(body.commits[0]!.repository).toBe("acme/api");
      });

      it("refuses to let an empty list read as no code change", async () => {
        const result = await executeTool(
          commits,
          { version: "api@1.4.2" },
          await toolContext(ALERT),
        );
        const body = parsedContent<{ note: string }>(result);

        expect(result.isError).toBeUndefined();
        expect(body.note).toContain("no repository integration");
      });
    });

    it("reports a missing scope as a permission failure the user fixes on the token", async () => {
      mock.status = 403;
      const result = await executeTool(releases, {}, await toolContext(ALERT));

      expect(result.isError).toBe(true);
      expect(result.content).toContain("project:read");
    });
  });

  /* The mock returns the list the client already read, so it agrees with it by
     construction. An error body served with 200 is what neither would catch. */
  it("refuses a page that is not a list rather than reporting no issues", async () => {
    await connect();
    mock.body = {
      detail: "You do not have permission to perform this action.",
    };

    const result = await executeTool(search, {}, await toolContext(ALERT));

    expect(result.isError).toBe(true);
    expect(result.content).toContain("other than a list of rows");
    expect(result.content).toContain("rather than as an absence");
  });
});
