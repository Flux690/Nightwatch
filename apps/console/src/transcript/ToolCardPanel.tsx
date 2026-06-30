import { Text } from "../ui/Text.js";
import type { ToolCardItem } from "./types.js";

export function ToolCardPanel({
  toolName,
  input,
  result,
}: Pick<ToolCardItem, "toolName" | "input" | "result">): React.JSX.Element {
  return (
    <div>
      <Text
        className="text-xs font-mono font-semibold"
        style={{ marginBottom: 4 }}
      >
        {toolName}
      </Text>
      <div
        style={{
          border: "1px solid var(--color-line)",
          borderRadius: "var(--radius-sm)",
          background: "var(--color-surface)",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: 4 }}>
          <Text
            className="text-xs text-ink-muted font-mono"
            style={{ marginBottom: 4 }}
          >
            IN
          </Text>
          <pre
            style={{
              margin: 0,
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
            }}
          >
            {JSON.stringify(input, null, 2)}
          </pre>
        </div>
        <div style={{ borderTop: "1px solid var(--color-line)" }} />
        <div style={{ padding: 4 }}>
          <Text
            className="text-xs text-ink-muted font-mono"
            style={{ marginBottom: 4 }}
          >
            OUT
          </Text>
          {result === null ? (
            <Text
              className="text-xs text-ink-muted font-mono"
              data-testid="tool-card-out-loading"
            >
              …
            </Text>
          ) : (
            <pre
              style={{
                margin: 0,
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
              }}
            >
              {JSON.stringify(result, null, 2)}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
