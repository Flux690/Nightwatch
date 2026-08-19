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

function mergedLabel(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return ` · merged ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function ChangesList({
  pullRequests,
}: {
  pullRequests: PullRequest[];
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
    </ul>
  );
}
