import { asRecord, numberAt, stringAt } from "@/lib/toolResult";

// Merged pull requests from a cited change query, read out of the recorded
// result rather than a copy stored on the report.

interface PullRequest {
  number: number;
  title: string;
  author: string;
  mergedAt: string;
  url: string;
}

// Empty when the result names none, which is the caller's cue to quote the
// result instead of rendering an empty section.
export function pullRequestsFrom(result: unknown): PullRequest[] {
  const record = asRecord(result);
  const raw = record === null ? null : record["pullRequests"];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const pr = asRecord(entry);
    if (pr === null) return [];
    const number = numberAt(pr, "number");
    const title = stringAt(pr, "title");
    const url = stringAt(pr, "url");
    if (number === null || title === null || url === null) return [];
    return [
      {
        number,
        title,
        url,
        author: stringAt(pr, "author") ?? "unknown",
        mergedAt: stringAt(pr, "mergedAt") ?? "",
      },
    ];
  });
}

/* Commits, which GetRecentChanges returns beside the pull requests and which
   nothing drew. An incident caused by a commit pushed straight to the branch
   rendered as bare prose while one caused by a pull request got a link, so what
   a report could show depended on how the change happened to land. */
export interface Commit {
  sha: string;
  message: string;
  author: string;
  committedAt: string;
}

export function commitsFrom(result: unknown): Commit[] {
  const record = asRecord(result);
  const raw = record === null ? null : record["commits"];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const commit = asRecord(entry);
    if (commit === null) return [];
    const sha = stringAt(commit, "sha");
    const message = stringAt(commit, "message");
    if (sha === null || message === null) return [];
    return [
      {
        sha,
        // Subject only: a commit body is prose the report has no room for.
        message: message.split("\n")[0] ?? message,
        author: stringAt(commit, "author") ?? "unknown",
        committedAt: stringAt(commit, "committedAt") ?? "",
      },
    ];
  });
}

function clockLabel(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function mergedLabel(iso: string): string {
  return iso ? ` · merged ${clockLabel(iso)}` : "";
}

function committedLabel(iso: string): string {
  return iso ? ` · ${clockLabel(iso)}` : "";
}

export function ChangesList({
  pullRequests,
  commits = [],
}: {
  pullRequests: PullRequest[];
  commits?: Commit[];
}): React.JSX.Element {
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0">
      {pullRequests.map((pr) => (
        <li key={pr.number} className="flex min-w-0 items-baseline gap-2">
          <a
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 truncate text-sm font-medium text-ring no-underline hover:underline"
          >
            #{pr.number} {pr.title}
          </a>
          <span className="shrink-0 text-sm text-muted-foreground">
            {pr.author}
            {mergedLabel(pr.mergedAt)}
          </span>
        </li>
      ))}
      {/* Beneath the pull requests: a commit on the branch is the smaller fact,
          and one that arrived through a PR is already named above. */}
      {commits.map((commit) => (
        <li key={commit.sha} className="flex min-w-0 items-baseline gap-2">
          <code className="shrink-0 text-sm text-muted-foreground">
            {commit.sha.slice(0, 7)}
          </code>
          <span className="min-w-0 flex-1 text-sm text-foreground">
            {commit.message}
          </span>
          <span className="shrink-0 text-sm text-muted-foreground">
            {commit.author}
            {committedLabel(commit.committedAt)}
          </span>
        </li>
      ))}
    </ul>
  );
}
