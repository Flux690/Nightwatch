import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import { Alert } from "../ui/Alert.js";
import { Badge } from "../ui/Badge.js";
import { Button } from "../ui/Button.js";
import { Code } from "../ui/Code.js";
import { Group } from "../ui/Group.js";
import { IconButton } from "../ui/IconButton.js";
import { Stack } from "../ui/Stack.js";
import { Text } from "../ui/Text.js";
import { toast } from "../ui/Toast.js";
import { apiFetch } from "../api/client.js";

export function IngestCredentialSection(): React.JSX.Element {
  const queryClient = useQueryClient();
  const { data: ingestCredential } = useQuery<{ configured: boolean }>({
    queryKey: ["ingest-credential"],
    queryFn: () => apiFetch<{ configured: boolean }>("/api/ingest-credential"),
  });

  const [generating, setGenerating] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [token, setToken] = useState<string | null>(null);
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
      toast.show({
        title: "Could not generate credential",
        message: err instanceof Error ? err.message : "Try again.",
        variant: "error",
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
      toast.show({
        title: "Could not reveal credential",
        message: err instanceof Error ? err.message : "Try again.",
        variant: "error",
      });
    } finally {
      setRevealing(false);
    }
  }

  function copyToken(): void {
    if (token !== null) void navigator.clipboard.writeText(token);
  }

  return (
    <Stack className="gap-3">
      <Group className="gap-2 items-center">
        <Text className="text-sm font-medium">Ingest credential</Text>
        <Badge intent={ingestCredential?.configured ? "success" : undefined}>
          {ingestCredential?.configured ? "Configured" : "Not configured"}
        </Badge>
      </Group>
      <Group className="gap-2">
        <Button
          size="xs"
          variant="secondary"
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
            variant="ghost"
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
          intent={tokenFresh ? "warning" : "info"}
          title={
            tokenFresh
              ? "New credential issued - the previous one no longer works"
              : "Ingest credential"
          }
          withCloseButton
          onClose={() => setToken(null)}
        >
          <Group className="gap-2 items-start flex-nowrap">
            <Code
              block
              style={{
                flex: 1,
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
              }}
            >
              {token}
            </Code>
            <IconButton aria-label="Copy ingest credential" onClick={copyToken}>
              <Copy size={16} strokeWidth={1.75} aria-hidden="true" />
            </IconButton>
          </Group>
        </Alert>
      )}
    </Stack>
  );
}
