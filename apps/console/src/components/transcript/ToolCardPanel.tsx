import { Card, CardContent } from "@/components/ui/card";
import type { ToolCardItem } from "./types.js";

export function ToolCardPanel({
  toolName,
  input,
  result,
}: Pick<ToolCardItem, "toolName" | "input" | "result">): React.JSX.Element {
  const preClass =
    "m-0 max-h-80 overflow-auto font-mono text-sm break-all whitespace-pre-wrap";
  const ioLabelClass =
    "mb-1.5 font-mono text-xs font-medium tracking-[0.06em] text-muted-foreground";

  return (
    <div data-testid="tool-card">
      <p className="mb-1.5 font-mono text-xs font-medium">{toolName}</p>
      <Card size="sm" className="gap-0 py-0">
        <CardContent className="px-3.5 py-2.5">
          <p className={ioLabelClass}>IN</p>
          <pre className={preClass}>{JSON.stringify(input, null, 2)}</pre>
        </CardContent>
        <CardContent className="border-t border-border px-3.5 py-2.5">
          <p className={ioLabelClass}>OUT</p>
          {result === null ? (
            <p
              className="font-mono text-xs text-muted-foreground"
              data-testid="tool-card-out-loading"
            >
              …
            </p>
          ) : (
            <pre className={preClass}>{JSON.stringify(result, null, 2)}</pre>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
