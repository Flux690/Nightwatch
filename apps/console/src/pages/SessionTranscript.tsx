import { Text } from "@mantine/core";
import { useParams } from "@tanstack/react-router";

export function SessionTranscript(): React.JSX.Element {
  const { id } = useParams({ strict: false }) as { id: string };

  return (
    <div style={{ padding: "var(--mantine-spacing-md)" }}>
      <Text size="sm" c="dimmed" ff="monospace">
        session: {id}
      </Text>
    </div>
  );
}
