import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, X } from "lucide-react";

import {
  Alert,
  AlertTitle,
  AlertDescription,
  AlertAction,
} from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/lib/toast";
import { apiFetch } from "@/api/client";

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
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <p className="text-sm font-medium">Ingest credential</p>
        {ingestCredential?.configured ? (
          <Badge className="border-transparent bg-success-tint text-success">
            Configured
          </Badge>
        ) : (
          <Badge variant="secondary">Not configured</Badge>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="xs"
          variant="secondary"
          disabled={generating || revealing}
          onClick={() => void handleGenerate()}
        >
          {generating && <Spinner className="size-3" />}
          {ingestCredential?.configured
            ? "Rotate credential"
            : "Generate credential"}
        </Button>
        {ingestCredential?.configured && (
          <Button
            size="xs"
            variant="ghost"
            disabled={revealing || generating}
            onClick={() => void handleReveal()}
          >
            {revealing && <Spinner className="size-3" />}
            Reveal credential
          </Button>
        )}
      </div>
      {token !== null && (
        <Alert>
          <AlertTitle>
            {tokenFresh
              ? "New credential issued - the previous one no longer works"
              : "Ingest credential"}
          </AlertTitle>
          <AlertDescription>
            <div className="flex flex-nowrap items-start gap-2">
              <pre className="block flex-1 overflow-auto rounded-sm border border-border bg-card p-3 font-mono text-sm leading-normal whitespace-pre-wrap break-all text-foreground">
                {token}
              </pre>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Copy ingest credential"
                onClick={copyToken}
              >
                <Copy size={16} strokeWidth={1.75} aria-hidden="true" />
              </Button>
            </div>
          </AlertDescription>
          <AlertAction>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Dismiss"
              onClick={() => setToken(null)}
            >
              <X size={16} strokeWidth={1.75} aria-hidden="true" />
            </Button>
          </AlertAction>
        </Alert>
      )}
    </div>
  );
}
