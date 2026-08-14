import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, TriangleAlert } from "lucide-react";
import type { AlertSourceKind } from "@nightwarden/shared";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Page } from "@/components/layout/Page";
import { ConfirmDialog } from "@/components/layout/ConfirmDialog";
import { CopyableSnippet } from "@/components/layout/CopyableSnippet";
import { ICON_UI } from "@/lib/iconProps";
import { timeAgo } from "@/lib/time";
import { toast } from "@/lib/toast";
import { apiFetch } from "@/api/client";
import { ALERT_SOURCE_CONTENT } from "./alertSourceContent";

interface CredentialStatus {
  configured: boolean;
  ingestUrl: string;
  lastReceivedAt: string | null;
}

const MASKED_TOKEN = "nwi_ ••••••••";

export function AlertSourcePage({
  kind,
}: {
  kind: AlertSourceKind;
}): React.JSX.Element {
  const content = ALERT_SOURCE_CONTENT[kind];
  const queryClient = useQueryClient();
  const [token, setToken] = useState<string | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);

  const base = `/api/integrations/alerting/${kind}`;
  // Keyed by kind: two senders are two credentials with two status lines, and a
  // shared key would show one sender's delivery proof on the other's card.
  const queryKey = ["alert-source", kind];

  const { data: status, isLoading } = useQuery<CredentialStatus>({
    queryKey,
    queryFn: () => apiFetch<CredentialStatus>(base),
  });

  const generate = useMutation({
    mutationFn: () =>
      apiFetch<{ token: string }>(`${base}/credential`, { method: "POST" }),
    onSuccess: async ({ token: minted }) => {
      const rotating = status?.configured === true;
      setToken(minted);
      if (rotating) {
        toast.success(
          `Credential rotated - paste the updated credential into ${content.label}`,
        );
      }
      await queryClient.invalidateQueries({ queryKey });
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
      apiFetch<{ token: string }>(`${base}/credential/reveal`, {
        method: "POST",
      }),
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
        { label: content.label },
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
          {content.blurb}
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
              <p className="text-sm font-semibold">{content.setupStep}</p>
              <CopyableSnippet
                label={content.copyLabel}
                text={content.snippet(status.ingestUrl, token ?? MASKED_TOKEN)}
                actions={snippetActions}
                copyable={token !== null}
              />
            </section>

            {/* Stated where they are set: these fail without reporting. */}
            {content.warnings.map((warning) => (
              <Alert key={warning} variant="warning" className="max-w-3xl">
                <TriangleAlert {...ICON_UI} />
                <AlertDescription>{warning}</AlertDescription>
              </Alert>
            ))}

            {configured && (
              <section className="flex flex-col gap-2">
                <p className="text-sm font-semibold">{content.confirmStep}</p>
                {/* Delivery is observed, never probed: the sender dials in, so
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
        description={content.rotateDescription}
        confirmLabel="Rotate"
        destructive
        onConfirm={() => generate.mutate()}
      />
    </Page>
  );
}
