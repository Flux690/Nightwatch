import { Text, Title } from "@mantine/core";

export function RunnersPage(): React.JSX.Element {
  return (
    <div style={{ padding: "var(--mantine-spacing-md)" }}>
      <Title order={2} size="h4" mb="md">
        Runners
      </Title>
      <Text c="dimmed" size="sm">
        No runners connected yet.
      </Text>
    </div>
  );
}
