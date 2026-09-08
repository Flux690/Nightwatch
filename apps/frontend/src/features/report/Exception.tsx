import { asRecord, numberAt, stringAt } from "@/shared/lib/toolResult";

export interface ExceptionRow {
  title: string;
  culprit: string;
  // Counts for a search hit, the release for a single event: what places it.
  scope: string;
}

function issueRow(value: unknown): ExceptionRow[] {
  const record = asRecord(value);
  const title = record === null ? null : stringAt(record, "title");
  if (record === null || title === null) return [];
  const events = stringAt(record, "count");
  const users = numberAt(record, "userCount");
  return [
    {
      title,
      culprit: stringAt(record, "culprit") ?? "",
      scope: [
        events === null ? "" : `${events} events`,
        users === null ? "" : `${users} users`,
      ]
        .filter(Boolean)
        .join(" · "),
    },
  ];
}

// Two shapes under one kind: a search answers with issues, and reading one issue
// answers with the event itself.
export function exceptionRows(result: unknown): ExceptionRow[] {
  const record = asRecord(result);
  if (record === null) return [];
  const issues = record["issues"];
  if (Array.isArray(issues)) return issues.flatMap(issueRow);
  const title = stringAt(record, "title");
  if (title === null) return [];
  const release = asRecord(record["release"]);
  const version = release === null ? null : stringAt(release, "version");
  return [
    {
      title,
      culprit: stringAt(record, "culprit") ?? "",
      scope: version === null ? "" : `in ${version}`,
    },
  ];
}

export function Exception({
  rows,
}: {
  rows: ExceptionRow[];
}): React.JSX.Element {
  return (
    <ul className="m-0 flex list-none flex-col gap-3 p-0">
      {rows.map((row, at) => (
        <li key={`${row.title}-${at}`}>
          <p className="m-0 text-sm font-medium">{row.title}</p>
          {(row.culprit !== "" || row.scope !== "") && (
            <p className="m-0 mt-1 font-mono text-xs text-muted-foreground">
              {[row.culprit, row.scope].filter(Boolean).join(" · ")}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}
