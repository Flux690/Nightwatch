import { z } from "zod";
import { getSentryIntegration } from "../../integrations/store.js";
import {
  SentryApiError,
  issueTagValues,
  latestEvent,
  listReleases,
  releaseCommits,
  searchIssues,
  type SentryConnection,
} from "../../integrations/sentry.js";
import { alertAnchorFor } from "./alert-anchor.js";
import { ITEM_BUDGET_CHARS, fitWithinBudget } from "./result-budget.js";
import { apiTool, optionalText } from "./schema.js";
import type { Tool, ToolExecuteResult } from "./types.js";

const DEFAULT_LOOKBACK_MINUTES = 60;
const DEFAULT_LOOKFORWARD_MINUTES = 5;
const MAX_LOOKBACK_MINUTES = 10_080;
const DEFAULT_ISSUE_LIMIT = 25;
const MAX_ISSUE_LIMIT = 100;
const DEFAULT_RELEASE_COUNT = 20;
const MAX_RELEASE_COUNT = 100;
const MAX_TAG_VALUES = 100;

type Row = Record<string, unknown>;

function str(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

function num(row: Row, key: string): number | null {
  const value = row[key];
  return typeof value === "number" ? value : null;
}

function bool(row: Row, key: string): boolean | null {
  const value = row[key];
  return typeof value === "boolean" ? value : null;
}

function obj(row: Row, key: string): Row | null {
  const value = row[key];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Row)
    : null;
}

function list(row: Row, key: string): Row[] {
  const value = row[key];
  return Array.isArray(value)
    ? value.filter(
        (v): v is Row =>
          typeof v === "object" && v !== null && !Array.isArray(v),
      )
    : [];
}

// Evidence windows never extend into the future; errors after the alert are
// still evidence (did it stop?) up to now.
async function anchoredWindow(
  sessionId: string,
  back: number,
  forward: number,
): Promise<{ anchor: Date; start: Date; end: Date }> {
  const anchor = await alertAnchorFor(sessionId);
  return {
    anchor,
    start: new Date(anchor.getTime() - back * 60_000),
    end: new Date(Math.min(anchor.getTime() + forward * 60_000, Date.now())),
  };
}

/* Spelled out in full on every release, because "2h 14m before" alone leaves
   the reader to guess what it is before. */
export function relativeToAlert(at: Date, anchor: Date): string {
  const delta = at.getTime() - anchor.getTime();
  const side = delta <= 0 ? "before" : "after";
  const minutes = Math.floor(Math.abs(delta) / 60_000);
  if (minutes < 1) return `under a minute ${side} the alert fired`;
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const rest = minutes % 60;
  const parts = [
    ...(days > 0 ? [`${days}d`] : []),
    ...(hours > 0 ? [`${hours}h`] : []),
    ...(rest > 0 ? [`${rest}m`] : []),
  ];
  return `${parts.join(" ")} ${side} the alert fired`;
}

function describeScope(values: string[], everything: string): string {
  return values.length === 0 ? everything : values.join(", ");
}

function notConfigured(): ToolExecuteResult {
  return {
    content:
      "Sentry integration is not configured. The user can connect it from the Integrations page. Continue without error-tracking evidence.",
    isError: true,
  };
}

function corrective(err: unknown): ToolExecuteResult {
  if (err instanceof SentryApiError) {
    return {
      content: `Sentry request failed. ${err.message}`,
      isError: true,
    };
  }
  return {
    content: err instanceof Error ? err.message : String(err),
    isError: true,
  };
}

async function connection(): Promise<SentryConnection | null> {
  const row = await getSentryIntegration();
  return row === null
    ? null
    : { baseUrl: row.baseUrl, orgSlug: row.orgSlug, token: row.token };
}

interface WindowedCounts {
  count: string | null;
  userCount: number | null;
  firstSeen: string | null;
  lastSeen: string | null;
}

interface SentryIssueRow {
  id: string | null;
  shortId: string | null;
  title: string | null;
  culprit: string | null;
  level: string | null;
  status: string | null;
  substatus: string | null;
  isUnhandled: boolean | null;
  firstSeen: string | null;
  lastSeen: string | null;
  count: string | null;
  userCount: number | null;
  inWindow: WindowedCounts | null;
  project: string | null;
  permalink: string | null;
}

export interface SentryIssuesResult {
  issues: SentryIssueRow[];
  returned: number;
  limit: number;
  windowStart: string;
  windowEnd: string;
  projectsSearched: string;
  environmentsSearched: string;
  query: string;
  sort: string;
  nextCursor: string | null;
  issuesOmitted?: number;
  note: string;
}

function toIssue(row: Row): SentryIssueRow {
  const filtered = obj(row, "filtered");
  return {
    id: str(row, "id"),
    shortId: str(row, "shortId"),
    title: str(row, "title"),
    culprit: str(row, "culprit"),
    level: str(row, "level"),
    status: str(row, "status"),
    substatus: str(row, "substatus"),
    isUnhandled: bool(row, "isUnhandled"),
    firstSeen: str(row, "firstSeen"),
    lastSeen: str(row, "lastSeen"),
    count: str(row, "count"),
    userCount: num(row, "userCount"),
    inWindow:
      filtered === null
        ? null
        : {
            count: str(filtered, "count"),
            userCount: num(filtered, "userCount"),
            firstSeen: str(filtered, "firstSeen"),
            lastSeen: str(filtered, "lastSeen"),
          },
    project: str(obj(row, "project") ?? {}, "slug"),
    permalink: str(row, "permalink"),
  };
}

export interface SentryEventResult {
  issueId: string;
  eventId: string | null;
  dateCreated: string | null;
  title: string | null;
  culprit: string | null;
  platform: string | null;
  message: string | null;
  release: {
    version: string | null;
    dateCreated: string | null;
    dateReleased: string | null;
    lastCommit: Row | null;
    lastDeploy: Row | null;
  } | null;
  tags: Array<{ key: string | null; value: string | null }>;
  formatted?: string;
  entries?: unknown[];
  vendorFramesDropped?: number;
  note: string;
}

/* Sentry marks a frame it believes is the user's own code; the rest is library
   and runtime noise that dwarfs it in the budget. */
function trimFrames(entries: Row[]): { entries: Row[]; dropped: number } {
  let dropped = 0;
  const trimmed = entries.map((entry) => {
    if (str(entry, "type") !== "exception") return entry;
    const data = obj(entry, "data");
    if (data === null) return entry;
    const values = list(data, "values").map((value) => {
      const stacktrace = obj(value, "stacktrace");
      if (stacktrace === null) return value;
      const frames = list(stacktrace, "frames");
      const inApp = frames.filter((frame) => bool(frame, "inApp") === true);
      // Nothing marked in-app means the SDK never classified them, so cutting
      // by that flag would leave an empty trace rather than a shorter one.
      if (inApp.length === 0) return value;
      dropped += frames.length - inApp.length;
      return { ...value, stacktrace: { ...stacktrace, frames: inApp } };
    });
    return { ...entry, data: { ...data, values } };
  });
  return { entries: trimmed, dropped };
}

interface SentryReleaseRow {
  version: string | null;
  shortVersion: string | null;
  dateCreated: string | null;
  dateReleased: string | null;
  relativeToAlert: string | null;
  lastDeploy: Row | null;
  lastCommit: Row | null;
  commitCount: number | null;
  deployCount: number | null;
  newGroups: number | null;
  projects: string[];
}

export interface SentryReleasesResult {
  releases: SentryReleaseRow[];
  returned: number;
  alertFiredAt: string;
  projectsSearched: string;
  nextCursor: string | null;
  releasesOmitted?: number;
  note: string;
}

/* Dated from the deploy that finished where there is one, because that is when
   the code began running; dateReleased and dateCreated only say when it existed. */
function releaseMoment(row: Row, lastDeploy: Row | null): string | null {
  return (
    (lastDeploy === null ? null : str(lastDeploy, "dateFinished")) ??
    str(row, "dateReleased") ??
    str(row, "dateCreated")
  );
}

function toRelease(row: Row, anchor: Date): SentryReleaseRow {
  const lastDeploy = obj(row, "lastDeploy");
  const moment = releaseMoment(row, lastDeploy);
  const at = moment === null ? null : new Date(moment);
  return {
    version: str(row, "version"),
    shortVersion: str(row, "shortVersion"),
    dateCreated: str(row, "dateCreated"),
    dateReleased: str(row, "dateReleased"),
    relativeToAlert:
      at === null || Number.isNaN(at.getTime())
        ? null
        : relativeToAlert(at, anchor),
    lastDeploy,
    lastCommit: obj(row, "lastCommit"),
    commitCount: num(row, "commitCount"),
    deployCount: num(row, "deployCount"),
    newGroups: num(row, "newGroups"),
    projects: list(row, "projects").flatMap((p) => {
      const slug = str(p, "slug");
      return slug === null ? [] : [slug];
    }),
  };
}

const environments = z.array(z.string()).optional();
const cursor = optionalText;
const issueId = z.string().meta({
  description:
    "The Sentry issue id, copied from the id field of a SearchSentryIssues result.",
});

const window = {
  lookbackMinutes: z
    .number()
    .int()
    .min(1)
    .max(MAX_LOOKBACK_MINUTES)
    .default(DEFAULT_LOOKBACK_MINUTES)
    .meta({
      description: `How many minutes before the alert to search. A whole number from 1 to ${MAX_LOOKBACK_MINUTES}, which is one week, defaulting to ${DEFAULT_LOOKBACK_MINUTES}.`,
    }),
  lookforwardMinutes: z
    .number()
    .int()
    .min(1)
    .max(MAX_LOOKBACK_MINUTES)
    .default(DEFAULT_LOOKFORWARD_MINUTES)
    .meta({
      description: `How many minutes after the alert to search, never extending past now. A whole number from 1 to ${MAX_LOOKBACK_MINUTES}, defaulting to ${DEFAULT_LOOKFORWARD_MINUTES}.`,
    }),
};

const SEARCH_ISSUES_INPUT = z.object({
  query: z.string().default("").meta({
    description:
      "Sentry issue search syntax. Defaults to an empty string, which returns issues of every status. Sentry's own default of is:unresolved is never applied for you, so ask for it explicitly if you want it.",
  }),
  projects: z.array(z.string()).optional().meta({
    description:
      "Sentry project slugs to search. Omit to search every project the token can reach.",
  }),
  environments: environments.meta({
    description:
      "Sentry environment names to search, for example production. Omit to search every environment.",
  }),
  sort: z.enum(["freq", "date", "new", "user", "trends"]).default("freq").meta({
    description:
      "How to order results: freq by event count (which is what spiked), date by last seen, new by first seen, user by people affected. Defaults to freq.",
  }),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_ISSUE_LIMIT)
    .default(DEFAULT_ISSUE_LIMIT)
    .meta({
      description: `How many issues to return at most. A whole number from 1 to ${MAX_ISSUE_LIMIT}, defaulting to ${DEFAULT_ISSUE_LIMIT}.`,
    }),
  ...window,
  cursor: cursor.meta({
    description:
      "Fetch the next page, using the nextCursor value from a previous result of this tool. Omit for the first page.",
  }),
});

const LATEST_EVENT_INPUT = z.object({
  issueId,
  environments: environments.meta({
    description:
      "Restrict to these Sentry environment names. Omit to take the latest event from any environment.",
  }),
});

const TAG_VALUES_INPUT = z.object({
  issueId,
  key: z.string().meta({
    description:
      "The tag to break the issue down by, for example server_name or release.",
  }),
  environments: environments.meta({
    description:
      "Restrict to these Sentry environment names. Omit to cover every environment.",
  }),
});

const RELEASES_INPUT = z.object({
  projects: z.array(z.string()).optional().meta({
    description:
      "Sentry project slugs to list releases for. Omit to cover every project the token can reach.",
  }),
  query: optionalText.meta({
    description:
      "Match releases whose version contains this text. Omit to list every release.",
  }),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_RELEASE_COUNT)
    .default(DEFAULT_RELEASE_COUNT)
    .meta({
      description: `How many releases to return at most, newest first. A whole number from 1 to ${MAX_RELEASE_COUNT}, defaulting to ${DEFAULT_RELEASE_COUNT}.`,
    }),
  cursor: cursor.meta({
    description:
      "Fetch the next page of older releases, using the nextCursor value from a previous result of this tool.",
  }),
});

const RELEASE_COMMITS_INPUT = z.object({
  version: z.string().meta({
    description:
      "The release version, copied verbatim from the version field of a GetSentryReleases result.",
  }),
  cursor: cursor.meta({
    description:
      "Fetch the next page, using the nextCursor value from a previous result of this tool.",
  }),
});

export const SENTRY_TOOLS: Tool[] = [
  apiTool({
    name: "SearchSentryIssues",
    description:
      "List the errors Sentry recorded around the alert, newest activity first by default. Each result carries its title, where it happened, its level, how many events and users it affected, and which Sentry project it belongs to. Use it to find out whether anything was throwing while the alert fired, then call GetSentryLatestEvent on an issue id to read one in full. Search with Sentry's own issue syntax in the query argument, for example `is:unresolved level:error` or `release:api@1.4.2`; pass an empty string to search every issue whatever its status.",
    input: SEARCH_ISSUES_INPUT,
    effect: "read",
    policy: "auto",
    citable: true,
    renderAs: "exception",
    timeoutMs: 30_000,
    execute: async (input, ctx): Promise<ToolExecuteResult> => {
      const conn = await connection();
      if (conn === null) return notConfigured();
      const { query, sort, limit, cursor } = input;
      const projects = input.projects ?? [];
      const environments = input.environments ?? [];
      const { start, end } = await anchoredWindow(
        ctx.sessionId,
        input.lookbackMinutes,
        input.lookforwardMinutes,
      );

      try {
        const page = await searchIssues(conn, ctx.signal, {
          projects,
          environments,
          query,
          sort,
          limit,
          start,
          end,
          cursor: cursor ?? null,
        });
        const { kept, dropped } = fitWithinBudget(page.rows.map(toIssue));
        const notes: string[] = [
          "count and userCount are Sentry's totals for the issue; inWindow holds the counts restricted to the window searched, and is null when Sentry did not narrow them.",
        ];
        if (kept.length === 0) {
          notes.push(
            "No issues matched. That means none matched this query in this window and these projects, not that the service threw nothing - widen lookbackMinutes, clear the query, or check the project slugs.",
          );
        }
        if (page.nextCursor !== null) {
          notes.push(
            "More issues exist beyond this page; call again with the cursor argument set to nextCursor to read them.",
          );
        }
        if (dropped > 0) {
          notes.push(
            `${dropped} matching issue(s) are NOT in this result: it reached its ${ITEM_BUDGET_CHARS}-character budget. Narrow the query or lower limit.`,
          );
        }
        const result: SentryIssuesResult = {
          issues: kept,
          returned: kept.length,
          limit,
          windowStart: start.toISOString(),
          windowEnd: end.toISOString(),
          projectsSearched: describeScope(
            projects,
            "every project the token can reach",
          ),
          environmentsSearched: describeScope(
            environments,
            "every environment",
          ),
          query,
          sort,
          nextCursor: page.nextCursor,
          ...(dropped > 0 && { issuesOmitted: dropped }),
          note: notes.join(" "),
        };
        return { content: result };
      } catch (err) {
        return corrective(err);
      }
    },
  }),
  apiTool({
    name: "GetSentryLatestEvent",
    description:
      "Read the most recent occurrence of one Sentry issue in full: its exception and stack trace, the tags it carried, and the release the code was running when it happened. Take the issue id from SearchSentryIssues. Library and runtime stack frames are dropped where Sentry marked which frames are the application's own, and the result says how many were dropped.",
    input: LATEST_EVENT_INPUT,
    effect: "read",
    policy: "auto",
    citable: true,
    renderAs: "exception",
    timeoutMs: 30_000,
    execute: async (input, ctx): Promise<ToolExecuteResult> => {
      const conn = await connection();
      if (conn === null) return notConfigured();
      const { issueId } = input;
      const environments = input.environments ?? [];

      try {
        const event = await latestEvent(
          conn,
          ctx.signal,
          issueId,
          environments,
        );
        const release = obj(event, "release");
        const formatted = str(event, "formatted");
        const notes: string[] = [];
        let entries: unknown[] | undefined;
        let vendorFramesDropped: number | undefined;

        if (formatted === null) {
          const trimmed = trimFrames(list(event, "entries"));
          const budgeted = fitWithinBudget(trimmed.entries);
          entries = budgeted.kept;
          vendorFramesDropped = trimmed.dropped;
          if (budgeted.dropped > 0) {
            notes.push(
              `${budgeted.dropped} section(s) of this event are NOT in this result: it reached its ${ITEM_BUDGET_CHARS}-character budget.`,
            );
          }
        }
        if (release === null) {
          notes.push(
            "This event carries no release, so which build was running cannot be read from it.",
          );
        }

        const result: SentryEventResult = {
          issueId,
          eventId: str(event, "eventID"),
          dateCreated: str(event, "dateCreated"),
          title: str(event, "title"),
          culprit: str(event, "culprit"),
          platform: str(event, "platform"),
          message: str(event, "message"),
          release:
            release === null
              ? null
              : {
                  version: str(release, "version"),
                  dateCreated: str(release, "dateCreated"),
                  dateReleased: str(release, "dateReleased"),
                  lastCommit: obj(release, "lastCommit"),
                  lastDeploy: obj(release, "lastDeploy"),
                },
          tags: list(event, "tags").map((tag) => ({
            key: str(tag, "key"),
            value: str(tag, "value"),
          })),
          ...(formatted !== null && { formatted }),
          ...(entries !== undefined && { entries }),
          ...(vendorFramesDropped !== undefined && { vendorFramesDropped }),
          note: notes.join(" "),
        };
        return { content: result };
      } catch (err) {
        return corrective(err);
      }
    },
  }),
  apiTool({
    name: "GetSentryIssueTagValues",
    description:
      "Break one Sentry issue down by a tag, so you can tell whether it hit one host or all of them. Useful keys are server_name, release, environment, url and browser. Each value comes back with how many events carried it and when it was first and last seen. Sentry offers no time filter here, so this distribution covers the whole life of the issue rather than the window around the alert, and the result says so.",
    input: TAG_VALUES_INPUT,
    effect: "read",
    policy: "auto",
    citable: true,
    renderAs: "text",
    timeoutMs: 30_000,
    execute: async (input, ctx): Promise<ToolExecuteResult> => {
      const conn = await connection();
      if (conn === null) return notConfigured();
      const { issueId, key } = input;
      const environments = input.environments ?? [];

      try {
        const raw = await issueTagValues(
          conn,
          ctx.signal,
          issueId,
          key,
          environments,
        );
        const { kept, dropped } = fitWithinBudget(
          raw.slice(0, MAX_TAG_VALUES).map((row) => ({
            value: str(row, "value"),
            count: num(row, "count"),
            firstSeen: str(row, "firstSeen"),
            lastSeen: str(row, "lastSeen"),
          })),
        );
        const omitted = Math.max(0, raw.length - MAX_TAG_VALUES) + dropped;
        const notes = [
          `These counts cover the whole life of the issue, not the window around the alert: Sentry accepts no time range on this call. Read firstSeen and lastSeen on each value before treating any of it as concurrent with the alert.`,
        ];
        if (kept.length === 0) {
          notes.push(
            `No values recorded for the tag "${key}" on this issue, which means the tag was never set on its events rather than that the issue is narrow.`,
          );
        }
        if (omitted > 0) {
          notes.push(
            `${omitted} further value(s) are not shown; the ones here are the ones Sentry ranked first.`,
          );
        }
        const result = {
          issueId,
          key,
          values: kept,
          returned: kept.length,
          environmentsSearched: describeScope(
            environments,
            "every environment",
          ),
          ...(omitted > 0 && { valuesOmitted: omitted }),
          note: notes.join(" "),
        };
        return { content: result };
      } catch (err) {
        return corrective(err);
      }
    },
  }),
  apiTool({
    name: "GetSentryReleases",
    description:
      "List the releases Sentry knows about, newest first, each with when its last deploy finished and how long before or after the alert that was. Use it to find out whether something shipped just before the alert fired. Nothing is filtered by time, because a release that caused a slow failure can predate the alert by days; read relativeToAlert on each one and decide for yourself. newGroups is how many new issues Sentry first saw in that release.",
    input: RELEASES_INPUT,
    effect: "read",
    policy: "auto",
    citable: true,
    renderAs: "change",
    timeoutMs: 30_000,
    execute: async (input, ctx): Promise<ToolExecuteResult> => {
      const conn = await connection();
      if (conn === null) return notConfigured();
      const { limit, cursor } = input;
      const projects = input.projects ?? [];
      const anchor = await alertAnchorFor(ctx.sessionId);

      try {
        const page = await listReleases(
          conn,
          ctx.signal,
          projects,
          input.query ?? null,
          limit,
          cursor ?? null,
        );
        const { kept, dropped } = fitWithinBudget(
          page.rows.map((row) => toRelease(row, anchor)),
        );
        const notes: string[] = [];
        if (kept.length === 0) {
          notes.push(
            "Sentry lists no releases for these projects. That means no release has ever been registered with Sentry, not that nothing was deployed.",
          );
        }
        if (kept.some((r) => r.relativeToAlert === null)) {
          notes.push(
            "A release with a null relativeToAlert carries no deploy or release date in Sentry, so when its code started running is unknown.",
          );
        }
        if (page.nextCursor !== null) {
          notes.push(
            "Older releases exist beyond this page; call again with the cursor argument set to nextCursor to reach them.",
          );
        }
        if (dropped > 0) {
          notes.push(
            `${dropped} older release(s) are NOT in this result: it reached its ${ITEM_BUDGET_CHARS}-character budget.`,
          );
        }
        const result: SentryReleasesResult = {
          releases: kept,
          returned: kept.length,
          alertFiredAt: anchor.toISOString(),
          projectsSearched: describeScope(
            projects,
            "every project the token can reach",
          ),
          nextCursor: page.nextCursor,
          ...(dropped > 0 && { releasesOmitted: dropped }),
          note: notes.join(" "),
        };
        return { content: result };
      } catch (err) {
        return corrective(err);
      }
    },
  }),
  apiTool({
    name: "GetSentryReleaseCommits",
    description:
      "List the commits that went out in one release, with their authors, messages, repositories and pull requests. Take the version from GetSentryReleases. suspectCommitType, where Sentry set it, marks a commit Sentry associates with an error. This only answers when the Sentry project has a repository integration configured; without one a release carries no commits and the result says which case it is.",
    input: RELEASE_COMMITS_INPUT,
    effect: "read",
    policy: "auto",
    citable: true,
    renderAs: "change",
    timeoutMs: 30_000,
    execute: async (input, ctx): Promise<ToolExecuteResult> => {
      const conn = await connection();
      if (conn === null) return notConfigured();
      const { version, cursor } = input;

      try {
        const page = await releaseCommits(
          conn,
          ctx.signal,
          version,
          cursor ?? null,
        );
        const { kept, dropped } = fitWithinBudget(
          page.rows.map((row) => ({
            id: str(row, "id"),
            message: str(row, "message"),
            dateCreated: str(row, "dateCreated"),
            author: obj(row, "author"),
            repository: str(obj(row, "repository") ?? {}, "name"),
            pullRequest: obj(row, "pullRequest"),
            suspectCommitType: str(row, "suspectCommitType"),
          })),
        );
        const notes: string[] = [];
        if (kept.length === 0) {
          notes.push(
            "Sentry associates no commits with this release. That is what you see both when the release genuinely shipped no commits and when the Sentry project has no repository integration set up, and this call cannot tell those apart - check the integration before reading it as no code change.",
          );
        }
        if (page.nextCursor !== null) {
          notes.push(
            "More commits exist beyond this page; call again with the cursor argument set to nextCursor.",
          );
        }
        if (dropped > 0) {
          notes.push(
            `${dropped} commit(s) are NOT in this result: it reached its ${ITEM_BUDGET_CHARS}-character budget.`,
          );
        }
        const result = {
          version,
          commits: kept,
          returned: kept.length,
          nextCursor: page.nextCursor,
          ...(dropped > 0 && { commitsOmitted: dropped }),
          note: notes.join(" "),
        };
        return { content: result };
      } catch (err) {
        return corrective(err);
      }
    },
  }),
];
