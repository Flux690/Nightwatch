import { Badge, Box, Button, Card, Group, Stack, Text } from "@mantine/core";

function SessionRow({
  title,
  meta,
  state,
}: {
  title: string;
  meta: string;
  state: "streaming" | "awaiting" | "escalated";
}) {
  const stateColor = {
    streaming: "var(--nw-status-streaming)",
    awaiting: "var(--nw-status-awaiting)",
    escalated: "var(--nw-status-escalated)",
  }[state];

  const stateLabel = {
    streaming: "● Streaming",
    awaiting: "◌ Awaiting",
    escalated: "✕ Escalated",
  }[state];

  return (
    <Box
      px="md"
      py="sm"
      style={{
        borderLeft: `2px solid ${stateColor}`,
        borderBottom: "1px solid var(--nw-border)",
        background: "var(--nw-surface)",
      }}
    >
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <Stack gap={2}>
          <Text size="sm" ff="var(--nw-mono)" c="var(--nw-text)" fw={500}>
            {title}
          </Text>
          <Text size="xs" ff="var(--nw-mono)" c="var(--nw-text-muted)">
            {meta}
          </Text>
        </Stack>
        <Text size="xs" c={stateColor} fw={600} style={{ whiteSpace: "nowrap" }}>
          {stateLabel}
        </Text>
      </Group>
    </Box>
  );
}

function ToolCard({
  toolName,
  input,
  output,
}: {
  toolName: string;
  input: string;
  output: string;
}) {
  return (
    <Card
      p={0}
      radius="xs"
      style={{
        border: "1px solid var(--nw-border)",
        background: "var(--nw-surface)",
      }}
    >
      <Box
        px="sm"
        py={6}
        style={{ borderBottom: "1px solid var(--nw-border)" }}
      >
        <Text
          size="xs"
          ff="var(--nw-mono)"
          c="var(--nw-text-muted)"
          tt="uppercase"
          fw={600}
        >
          {toolName}
        </Text>
      </Box>
      <Box px="sm" py="xs" style={{ borderBottom: "1px solid var(--nw-border)" }}>
        <Text size="xs" c="var(--nw-accent)" ff="var(--nw-mono)" tt="uppercase" fw={600} mb={4}>
          IN
        </Text>
        <Text
          size="xs"
          ff="var(--nw-mono)"
          c="var(--nw-text)"
          style={{ whiteSpace: "pre-wrap" }}
        >
          {input}
        </Text>
      </Box>
      <Box px="sm" py="xs">
        <Text size="xs" c="var(--nw-text-muted)" ff="var(--nw-mono)" tt="uppercase" fw={600} mb={4}>
          OUT
        </Text>
        <Text
          size="xs"
          ff="var(--nw-mono)"
          c="var(--nw-text)"
          style={{ whiteSpace: "pre-wrap" }}
        >
          {output}
        </Text>
      </Box>
    </Card>
  );
}

function AssistantBubble({ children }: { children: string }) {
  return (
    <Box
      px="md"
      py="sm"
      maw={480}
      style={{
        background: "var(--nw-surface)",
        border: "1px solid var(--nw-border)",
        borderRadius: "1px",
      }}
    >
      <Text size="sm" c="var(--nw-text)">
        {children}
      </Text>
    </Box>
  );
}

export function FolioSample() {
  return (
    <Box
      p="xl"
      style={{ background: "var(--nw-bg)", minHeight: "100vh" }}
    >
      <Stack gap="xl" maw={640}>
        <Stack gap={4}>
          <Text size="lg" fw={700} c="var(--nw-text)">
            Folio — Design Token Sample
          </Text>
          <Text size="sm" c="var(--nw-text-muted)">
            Newsprint bg · crimson interactive · prussian navy live
          </Text>
        </Stack>

        <Stack gap={0} style={{ border: "1px solid var(--nw-border)", borderRadius: "1px" }}>
          <SessionRow
            title="redis-oom / prod-east-1a"
            meta="Investigating OOM fault · tool 4/9"
            state="streaming"
          />
          <SessionRow
            title="disk-pressure / worker-node-07"
            meta="Waiting for approval · exec_shell"
            state="awaiting"
          />
          <SessionRow
            title="net-split / api-gw-02"
            meta="Escalated to on-call · 01:22 elapsed"
            state="escalated"
          />
        </Stack>

        <ToolCard
          toolName="exec_shell"
          input={`$ df -h /var/lib/redis`}
          output={`Filesystem  Size  Used  Avail Use% Mounted on\n/dev/xvda1   50G   49G   512M  99% /var/lib/redis`}
        />

        <AssistantBubble>
          Memory usage has reached 99% of the allocated limit. This is consistent
          with a slow leak in the transcoder process — recommend restarting the
          container and increasing the memory limit to 64 GiB.
        </AssistantBubble>

        <Group gap="sm">
          <Button color="crimson" size="sm">
            Approve
          </Button>
          <Button variant="default" size="sm">
            Reject
          </Button>
          <Button variant="subtle" color="crimson" size="sm">
            View session
          </Button>
        </Group>

        <Group gap="xs">
          <Badge color="crimson" variant="light">Escalated</Badge>
          <Badge
            variant="light"
            style={{ background: "#1C3A5E1A", color: "var(--nw-status-streaming)" }}
          >
            Streaming
          </Badge>
          <Badge
            variant="light"
            style={{ background: "#7A4A001A", color: "var(--nw-status-awaiting)" }}
          >
            Awaiting
          </Badge>
        </Group>

        <Box p="sm" style={{ background: "var(--nw-surface)", border: "1px solid var(--nw-border)" }}>
          <Text size="xs" ff="var(--nw-mono)" c="var(--nw-text-muted)" mb={4}>
            session-id · hostname · tool-i/o in monospace
          </Text>
          <Text size="xs" ff="var(--nw-mono)" c="var(--nw-text)">
            nw-session-0042 · redis-cache-7d9f.us-east-1.internal · 14:03:22Z
          </Text>
        </Box>
      </Stack>
    </Box>
  );
}
