import { Text, Title } from "@mantine/core";

export function SettingsPage(): React.JSX.Element {
  return (
    <div style={{ padding: "var(--mantine-spacing-md)" }}>
      <Title order={2} size="h4" mb="md">
        Settings
      </Title>
      <Text c="dimmed" size="sm">
        Model and loop configuration.
      </Text>
    </div>
  );
}
