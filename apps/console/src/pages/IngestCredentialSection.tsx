import { useState } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Code,
  Group,
  Stack,
  Text,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../api/client.js";

// The fleet-wide alert ingest credential: status, rotate, and on-demand reveal.
// Fully self-contained - owns its query, the shown-token state, and its actions -
// so the Settings page just drops it in.
export function IngestCredentialSection(): React.JSX.Element {
  const queryClient = useQueryClient();
  const { data: ingestCredential } = useQuery<{ configured: boolean }>({
    queryKey: ["ingest-credential"],
    queryFn: () => apiFetch<{ configured: boolean }>("/api/ingest-credential"),
  });

  const [generating, setGenerating] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  // True when the shown token was just minted (old one now invalid) vs revealed.
  const [tokenFresh, setTokenFresh] = useState(false);

  async function handleGenerate(): Promise<void> {
    setGenerating(true);
    try {
      const { token: minted } = await apiFetch<{ token: string }>(
        "/api/ingest-credential",
        { method: "POST" },
      );
      setToken(minted);
      setTokenFresh(true);
      await queryClient.invalidateQueries({ queryKey: ["ingest-credential"] });
    } catch (err) {
      notifications.show({
        color: "red",
        title: "Could not generate credential",
        message: err instanceof Error ? err.message : "Try again.",
      });
    } finally {
      setGenerating(false);
    }
  }

  async function handleReveal(): Promise<void> {
    setRevealing(true);
    try {
      const { token: revealed } = await apiFetch<{ token: string }>(
        "/api/ingest-credential/reveal",
        { method: "POST" },
      );
      setToken(revealed);
      setTokenFresh(false);
    } catch (err) {
      notifications.show({
        color: "red",
        title: "Could not reveal credential",
        message: err instanceof Error ? err.message : "Try again.",
      });
    } finally {
      setRevealing(false);
    }
  }

  function copyToken(): void {
    if (token !== null) void navigator.clipboard.writeText(token);
  }

  return (
    <Stack gap="sm" mt="xl">
      <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
        Alerting
      </Text>
      <Group gap="xs" align="center">
        <Text size="sm" fw={500}>
          Ingest credential
        </Text>
        <Badge
          color={ingestCredential?.configured ? "green" : "gray"}
          variant="light"
        >
          {ingestCredential?.configured ? "Configured" : "Not configured"}
        </Badge>
      </Group>
      <Group gap="xs">
        <Button
          size="xs"
          variant="default"
          loading={generating}
          disabled={revealing}
          onClick={() => void handleGenerate()}
        >
          {ingestCredential?.configured
            ? "Rotate credential"
            : "Generate credential"}
        </Button>
        {ingestCredential?.configured && (
          <Button
            size="xs"
            variant="subtle"
            loading={revealing}
            disabled={generating}
            onClick={() => void handleReveal()}
          >
            Reveal credential
          </Button>
        )}
      </Group>
      {token !== null && (
        <Alert
          color={tokenFresh ? "yellow" : "blue"}
          title={
            tokenFresh
              ? "New credential issued — the previous one no longer works"
              : "Ingest credential"
          }
          withCloseButton
          onClose={() => setToken(null)}
        >
          <Group gap="xs" align="flex-start" wrap="nowrap">
            <Code
              block
              style={{
                flex: 1,
                fontFamily: "var(--nw-mono)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
              }}
            >
              {token}
            </Code>
            <ActionIcon
              variant="default"
              size="lg"
              aria-label="Copy ingest credential"
              onClick={copyToken}
            >
              ⧉
            </ActionIcon>
          </Group>
        </Alert>
      )}
    </Stack>
  );
}
