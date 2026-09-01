import { describeNetworkFailure } from "./reachability.js";
import type { SentryErrorCode } from "@nightwarden/shared";

export class SentryApiError extends Error {
  constructor(
    readonly code: SentryErrorCode,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SentryApiError";
  }
}

// Issues and events answer to event:read; releases, deploys and commits answer
// to project:read. A token holding one and not the other fails only half way.
export type SentryScope = "event:read" | "project:read";

// Kept under the tools' 30s budget so Sentry gives up before the tool call does.
const FETCH_TIMEOUT_MS = 28_000;

// Every path is organization-scoped, so the slug is part of the address rather
// than a filter, and a wrong one is a 404 the probe has to name.
function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/api/0${path}`;
}

export interface SentryConnection {
  baseUrl: string;
  orgSlug: string;
  token: string;
}

/* A page of rows and the cursor that reaches the next one. Sentry paginates by
   Link header, so nothing here shifts a time window to page. */
export interface SentryPage<T> {
  rows: T[];
  nextCursor: string | null;
}

/* rel="next" is always present; results="true" is what says the page it points
   at holds anything, so following it on "false" fetches an empty page forever. */
export function parseNextCursor(link: string | null): string | null {
  if (link === null) return null;
  for (const part of link.split(",")) {
    if (!/rel="next"/.test(part)) continue;
    if (!/results="true"/.test(part)) return null;
    const cursor = /cursor="([^"]*)"/.exec(part);
    return cursor?.[1] ?? null;
  }
  return null;
}

async function sentryFetch(
  conn: SentryConnection,
  path: string,
  params: URLSearchParams,
): Promise<Response> {
  const qs = params.toString();
  const url = `${joinUrl(conn.baseUrl, path)}${qs === "" ? "" : `?${qs}`}`;
  try {
    return await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        "User-Agent": "nightwarden",
        Authorization: `Bearer ${conn.token}`,
      },
    });
  } catch (err) {
    throw new SentryApiError(
      "network",
      0,
      describeNetworkFailure(err, "Sentry"),
    );
  }
}

// 403 names the scope the caller needed, because that is the one failure the
// user fixes on the token they already made rather than by making another.
function describeStatus(status: number, scope: SentryScope): string {
  if (status === 401) {
    return "Sentry rejected the token. Check that it is valid and not revoked.";
  }
  if (status === 403) {
    return `Sentry accepted the token but refused the request, which means it is missing the ${scope} scope. Add it to the token in Sentry and reconnect.`;
  }
  // The organization, the issue and the release all sit in the path, so a 404
  // cannot say which of them Sentry failed to find.
  return "Sentry returned 404, so something named in the request does not exist there: the organization slug, or the issue or release the call asked for.";
}

async function readJson(
  res: Response,
  scope: SentryScope,
): Promise<{ body: unknown; nextCursor: string | null }> {
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    const code: SentryErrorCode =
      res.status === 401
        ? "unauthorized"
        : res.status === 403
          ? "forbidden"
          : "not_found";
    throw new SentryApiError(
      code,
      res.status,
      describeStatus(res.status, scope),
    );
  }
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 300);
    throw new SentryApiError(
      "bad_response",
      res.status,
      `Sentry returned ${res.status}${text ? `: ${text}` : ""}`,
    );
  }
  try {
    return {
      body: await res.json(),
      nextCursor: parseNextCursor(res.headers.get("link")),
    };
  } catch {
    throw new SentryApiError(
      "bad_response",
      res.status,
      `Sentry returned a non-JSON body (HTTP ${res.status}) - is this URL a Sentry instance?`,
    );
  }
}

function rows(body: unknown): Array<Record<string, unknown>> {
  return Array.isArray(body)
    ? body.filter(
        (row): row is Record<string, unknown> =>
          typeof row === "object" && row !== null && !Array.isArray(row),
      )
    : [];
}

async function getList(
  conn: SentryConnection,
  path: string,
  params: URLSearchParams,
  scope: SentryScope,
): Promise<SentryPage<Record<string, unknown>>> {
  const res = await sentryFetch(conn, path, params);
  const { body, nextCursor } = await readJson(res, scope);
  return { rows: rows(body), nextCursor };
}

export interface IssueSearch {
  projects: string[];
  environments: string[];
  query: string;
  sort: string;
  limit: number;
  start: Date;
  end: Date;
  cursor: string | null;
}

/* start/end rather than statsPeriod, always: Sentry documents statsPeriod as
   overriding both, which would silently discard the alert anchor. */
export async function searchIssues(
  conn: SentryConnection,
  search: IssueSearch,
): Promise<SentryPage<Record<string, unknown>>> {
  const params = new URLSearchParams({
    start: search.start.toISOString(),
    end: search.end.toISOString(),
    // Sent even when empty: the server default is `is:unresolved`, which during
    // an incident hides the resolved and ignored issues without saying so.
    query: search.query,
    sort: search.sort,
    limit: String(search.limit),
  });
  for (const project of search.projects) params.append("project", project);
  for (const env of search.environments) params.append("environment", env);
  if (search.cursor !== null) params.set("cursor", search.cursor);
  return await getList(
    conn,
    `/organizations/${encodeURIComponent(conn.orgSlug)}/issues/`,
    params,
    "event:read",
  );
}

/* `latest` is a value the event_id path segment accepts, alongside an id,
   `oldest` and `recommended`; there is no separate endpoint for it. */
export async function latestEvent(
  conn: SentryConnection,
  issueId: string,
  environments: string[],
): Promise<Record<string, unknown>> {
  const params = new URLSearchParams();
  for (const env of environments) params.append("environment", env);
  // Sentry renders the event for a model when it can; absent on older
  // self-hosted versions, so the caller falls back to trimming frames itself.
  params.set("llmFormat", "markdown");
  const res = await sentryFetch(
    conn,
    `/organizations/${encodeURIComponent(conn.orgSlug)}/issues/${encodeURIComponent(issueId)}/events/latest/`,
    params,
  );
  const { body } = await readJson(res, "event:read");
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

// No time parameters exist on this endpoint, so the distribution it returns
// spans the issue's whole life and the tool has to say so.
export async function issueTagValues(
  conn: SentryConnection,
  issueId: string,
  key: string,
  environments: string[],
): Promise<Array<Record<string, unknown>>> {
  const params = new URLSearchParams();
  for (const env of environments) params.append("environment", env);
  const page = await getList(
    conn,
    `/organizations/${encodeURIComponent(conn.orgSlug)}/issues/${encodeURIComponent(issueId)}/tags/${encodeURIComponent(key)}/values/`,
    params,
    "event:read",
  );
  return page.rows;
}

// Also takes no window, which is why the tool orders and annotates rather than
// filtering: a release that broke something can predate the alert by days.
export async function listReleases(
  conn: SentryConnection,
  projects: string[],
  query: string | null,
  perPage: number,
  cursor: string | null,
): Promise<SentryPage<Record<string, unknown>>> {
  const params = new URLSearchParams({ per_page: String(perPage) });
  for (const project of projects) params.append("project", project);
  if (query !== null) params.set("query", query);
  if (cursor !== null) params.set("cursor", cursor);
  return await getList(
    conn,
    `/organizations/${encodeURIComponent(conn.orgSlug)}/releases/`,
    params,
    "project:read",
  );
}

export async function releaseCommits(
  conn: SentryConnection,
  version: string,
  cursor: string | null,
): Promise<SentryPage<Record<string, unknown>>> {
  const params = new URLSearchParams();
  if (cursor !== null) params.set("cursor", cursor);
  return await getList(
    conn,
    `/organizations/${encodeURIComponent(conn.orgSlug)}/releases/${encodeURIComponent(version)}/commits/`,
    params,
    "project:read",
  );
}

/* Two calls because the two scopes fail independently: a token with only
   event:read connects and then answers nothing about releases at 3am. */
export async function probeSentry(conn: SentryConnection): Promise<void> {
  await getList(
    conn,
    `/organizations/${encodeURIComponent(conn.orgSlug)}/issues/`,
    new URLSearchParams({ limit: "1", query: "" }),
    "event:read",
  );
  await getList(
    conn,
    `/organizations/${encodeURIComponent(conn.orgSlug)}/releases/`,
    new URLSearchParams({ per_page: "1" }),
    "project:read",
  );
}
