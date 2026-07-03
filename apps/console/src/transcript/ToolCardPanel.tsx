import { Text } from "../ui/Text.js";
import type { ToolCardItem } from "./types.js";

export function ToolCardPanel({
  toolName,
  input,
  result,
}: Pick<ToolCardItem, "toolName" | "input" | "result">): React.JSX.Element {
  return (
    <div data-testid="tool-card">
      <Text className="tool-card__name">{toolName}</Text>
      <div className="tool-card">
        <div className="tool-card__section">
          <Text className="tool-card__io-label">IN</Text>
          <pre className="tool-card__pre">{JSON.stringify(input, null, 2)}</pre>
        </div>
        <div className="tool-card__divider" />
        <div className="tool-card__section">
          <Text className="tool-card__io-label">OUT</Text>
          {result === null ? (
            <Text
              className="text-xs text-ink-muted font-mono"
              data-testid="tool-card-out-loading"
            >
              …
            </Text>
          ) : (
            <pre className="tool-card__pre">
              {JSON.stringify(result, null, 2)}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
