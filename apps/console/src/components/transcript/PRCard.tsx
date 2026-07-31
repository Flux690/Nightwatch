import { ExternalLink } from "lucide-react";

import { MetaText, StatusText } from "@/components/ui/status";
import { Card, CardContent } from "@/components/ui/card";
import { TOOL_CARD_CLASS } from "./cardChrome.js";
import { ICON_UI } from "@/lib/iconProps";
import { asRecord } from "@/lib/toolResult";

export interface PullRequestResult {
  action: "created" | "updated";
  number: number;
  url: string;
  draft: boolean;
  message?: string;
}

export function parsePullRequestResult(
  result: unknown,
): PullRequestResult | null {
  const record = asRecord(result);
  if (record === null) return null;
  if (
    (record["action"] !== "created" && record["action"] !== "updated") ||
    typeof record["number"] !== "number" ||
    typeof record["url"] !== "string"
  ) {
    return null;
  }
  return {
    action: record["action"],
    number: record["number"],
    url: record["url"],
    draft: record["draft"] === true,
    ...(typeof record["message"] === "string" && {
      message: record["message"],
    }),
  };
}

export function PRCard({ pr }: { pr: PullRequestResult }): React.JSX.Element {
  return (
    <div data-testid="pr-card">
      <p className="mb-1.5 font-mono text-base font-medium">OpenPullRequest</p>
      <Card size="sm" className={TOOL_CARD_CLASS}>
        <CardContent className="flex flex-wrap items-center gap-2 px-3.5 py-2.5">
          <span className="text-base font-medium">
            Pull request #{pr.number}
          </span>
          <StatusText tone={pr.draft ? "muted" : "ok"}>
            {pr.draft ? "Draft" : "Open"}
          </StatusText>
          <MetaText>{pr.action}</MetaText>
          <a
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            className="ml-auto inline-flex items-center gap-1 text-base font-medium text-primary no-underline hover:underline"
          >
            View on GitHub
            <ExternalLink {...ICON_UI} />
          </a>
        </CardContent>
        {pr.message !== undefined && (
          <CardContent className="border-t border-border px-3.5 py-2 text-base text-muted-foreground">
            <p className="m-0">{pr.message}</p>
          </CardContent>
        )}
      </Card>
    </div>
  );
}
