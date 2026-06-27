import { Text } from "@mantine/core";
import type { ToolCardItem } from "./types.js";

// The IN/OUT block shared by the standalone tool card and the resolved
// approval/clarification cards; result === null renders the in-flight placeholder.
export function ToolCardPanel({
  toolName,
  input,
  result,
}: Pick<ToolCardItem, "toolName" | "input" | "result">): React.JSX.Element {
  return (
    <div>
      <Text size="xs" ff="monospace" fw={600} mb={4}>
        {toolName}
      </Text>
      <div
        style={{
          border: "1px solid var(--nw-border)",
          borderRadius: "var(--mantine-radius-sm)",
          background: "var(--nw-surface)",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "var(--mantine-spacing-xs)" }}>
          <Text size="xs" c="dimmed" ff="monospace" mb={4}>
            IN
          </Text>
          <pre
            style={{
              margin: 0,
              fontFamily: "var(--nw-mono)",
              fontSize: 12,
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
            }}
          >
            {JSON.stringify(input, null, 2)}
          </pre>
        </div>
        <div style={{ borderTop: "1px solid var(--nw-border)" }} />
        <div style={{ padding: "var(--mantine-spacing-xs)" }}>
          <Text size="xs" c="dimmed" ff="monospace" mb={4}>
            OUT
          </Text>
          {result === null ? (
            <Text
              size="xs"
              c="dimmed"
              ff="monospace"
              data-testid="tool-card-out-loading"
            >
              …
            </Text>
          ) : (
            <pre
              style={{
                margin: 0,
                fontFamily: "var(--nw-mono)",
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
