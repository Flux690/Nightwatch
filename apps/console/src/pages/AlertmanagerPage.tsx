import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Page } from "@/components/layout/Page";
import { ConfirmDialog } from "@/components/layout/ConfirmDialog";
import { CopyableSnippet } from "@/components/layout/CopyableSnippet";
import { ICON_UI } from "@/lib/iconProps";
import { timeAgo } from "@/lib/time";
import { toast } from "@/lib/toast";
import { apiFetch } from "@/api/client";

interface CredentialStatus {
  configured: boolean;
  ingestUrl: string;
  lastReceivedAt: string | null;
}

const MASKED_TOKEN = "nwi_ ••••••••";

function receiverSnippet(ingestUrl: string, token: string): string {
  return [
    "receivers:",
    "  - name: nightwarden",
    "    webhook_configs:",
    `      - url: '${ingestUrl}'`,
    "        http_config:",
    "          authorization:",
    "            type: Bearer",
    `            credentials: '${token}'`,
  ].join("\n");
}

export function AlertmanagerPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [token, setToken] = useState<string | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);

  const { data: status, isLoading } = useQuery<CredentialStatus>({
    queryKey: ["alertmanager-integration"],
    queryFn: () => apiFetch<CredentialStatus>("/api/integrations/alertmanager"),
  });

  const generate = useMutation({
    mutationFn: () =>
      apiFetch<{ token: string }>("/api/integrations/alertmanager/credential", {
        method: "POST",
      }),
    onSuccess: async ({ token: minted }) => {
      const rotating = status?.configured === true;
      setToken(minted);
      if (rotating) {
        toast.success(
          "Credential rotated - paste the updated receiver into your Alertmanager",
        );
      }
      await queryClient.invalidateQueries({
        queryKey: ["alertmanager-integration"],
      });
    },
    onError: (err) =>
      toast.show({
        title: "Could not generate credential",
        message: err instanceof Error ? err.message : "Try again.",
        variant: "error",
      }),
  });

  const reveal = useMutation({
    mutationFn: () =>
      apiFetch<{ token: string }>(
        "/api/integrations/alertmanager/credential/reveal",
        {
          method: "POST",
        },
      ),
    onSuccess: ({ token: revealed }) => setToken(revealed),
    onError: (err) =>
      toast.show({
        title: "Could not show the token",
        message: err instanceof Error ? err.message : "Try again.",
        variant: "error",
      }),
  });

  const busy = generate.isPending || reveal.isPending;
  const configured = status?.configured === true;
  // Minting in this visit (setup or rotation) means the user is mid-setup: the
  // page reads as steps to finish, not as a status report on unfinished work.
  const showStatus = configured && !generate.isSuccess;

  const snippetActions = !configured ? (
    <Button size="xs" disabled={busy} onClick={() => generate.mutate()}>
      {generate.isPending && <Spinner className="size-3" />}
      Generate credential
    </Button>
  ) : token === null ? (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Show token"
      disabled={busy}
      onClick={() => reveal.mutate()}
    >
      <Eye {...ICON_UI} />
    </Button>
  ) : (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Hide token"
      onClick={() => setToken(null)}
    >
      <EyeOff {...ICON_UI} />
    </Button>
  );

  return (
    <Page
      crumbs={[
        { label: "Integrations", to: "/integrations" },
        { label: "Alertmanager" },
      ]}
      controls={
        showStatus && status ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span
              aria-hidden="true"
              className={
                status.lastReceivedAt !== null
                  ? "size-1.5 rounded-full bg-success"
                  : "size-1.5 rounded-full bg-muted-foreground"
              }
            />
            {status.lastReceivedAt !== null
              ? `Receiving - last alert ${timeAgo(status.lastReceivedAt)} ago`
              : "Waiting for first alert"}
          </div>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-8">
        <p className="max-w-3xl text-sm text-muted-foreground">
          Forward alerts from the Alertmanager you already run. One credential
          covers the whole fleet.
        </p>

        {isLoading && (
          <div className="flex items-center gap-2">
            <Spinner />
            <p className="text-sm text-muted-foreground">Loading...</p>
          </div>
        )}

        {status && (
          <>
            <section className="flex flex-col gap-2">
              <p className="text-sm font-semibold">
                1. Paste this receiver into your alertmanager.yml
              </p>
              <CopyableSnippet
                label="Copy Alertmanager receiver"
                text={receiverSnippet(status.ingestUrl, token ?? MASKED_TOKEN)}
                actions={snippetActions}
                copyable={token !== null}
              />
            </section>

            {configured && (
              <section className="flex flex-col gap-2">
                <p className="text-sm font-semibold">2. Reload Alertmanager</p>
                {/* Delivery is observed, never probed: Alertmanager dials in, so
                    the status line is the proof. A button posting from this
                    browser would exercise a leg that already demonstrably works. */}
                <p className="max-w-3xl text-sm text-muted-foreground">
                  The status line above reports your first delivery.
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    size="xs"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => setConfirmRotate(true)}
                  >
                    Rotate credential
                  </Button>
                </div>
              </section>
            )}
          </>
        )}
      </div>

      <ConfirmDialog
        open={confirmRotate}
        onOpenChange={setConfirmRotate}
        title="Rotate credential?"
        description="The current credential stops working immediately, and your Alertmanager stops delivering until you paste the updated receiver."
        confirmLabel="Rotate"
        destructive
        onConfirm={() => generate.mutate()}
      />
    </Page>
  );
}
