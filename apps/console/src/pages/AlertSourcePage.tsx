import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useBlocker, useNavigate } from "@tanstack/react-router";
import { TriangleAlert } from "lucide-react";
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

export function AlertSourcePage({
  kind,
}: {
  kind: AlertSourceKind;
}): React.JSX.Element {
  const content = ALERT_SOURCE_CONTENT[kind];
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // Set only by a mint, cleared only by the user saying they have copied it.
  // Nothing can put it back: the API keeps no readable copy.
  const [token, setToken] = useState<string | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const base = `/api/integrations/alerting/${kind}`;
  // Keyed by kind: two senders are two credentials with two status lines, and a
  // shared key would show one sender's delivery proof on the other's card.
  const queryKey = ["alert-source", kind];

  const { data: status, isLoading } = useQuery<CredentialStatus>({
    queryKey,
    queryFn: () => apiFetch<CredentialStatus>(base),
  });

  const unsaved = token !== null;
  const blocker = useBlocker({
    shouldBlockFn: () => true,
    disabled: !unsaved,
    enableBeforeUnload: () => unsaved,
    withResolver: true,
  });

  const generate = useMutation({
    mutationFn: () =>
      apiFetch<{ token: string }>(`${base}/credential`, { method: "POST" }),
    onSuccess: async ({ token: minted }) => {
      setToken(minted);
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: (err) =>
      toast.show({
        title: "Could not generate credential",
        message: err instanceof Error ? err.message : "Try again.",
        variant: "error",
      }),
  });

  const disconnect = useMutation({
    mutationFn: () => apiFetch<void>(base, { method: "DELETE" }),
    onSuccess: async () => {
      toast.success(`${content.label} disconnected`);
      await queryClient.invalidateQueries({ queryKey });
      void navigate({ to: "/integrations" });
    },
    onError: (err) =>
      toast.show({
        title: "Could not disconnect",
        message: err instanceof Error ? err.message : "Try again.",
        variant: "error",
      }),
  });

  const configured = status?.configured === true;
  const template = content.template?.(status?.ingestUrl ?? "");

  return (
    <Page
      crumbs={[
        { label: "Integrations", to: "/integrations" },
        { label: content.label },
      ]}
      controls={
        configured && !unsaved && status ? (
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
        <p className="text-sm text-muted-foreground">{content.blurb}</p>

        {isLoading && (
          <div className="flex items-center gap-2">
            <Spinner />
            <p className="text-sm text-muted-foreground">Loading...</p>
          </div>
        )}

        {status && (
          <>
            {!configured && !unsaved && (
              <Button
                className="self-start"
                disabled={generate.isPending}
                onClick={() => generate.mutate()}
              >
                {generate.isPending && <Spinner className="size-4" />}
                Generate credential
              </Button>
            )}

            {/* Shown once and never again: the API stores only a hash of it. */}
            {token !== null && (
              <section className="flex flex-col gap-3">
                <Alert variant="warning">
                  <TriangleAlert {...ICON_UI} />
                  <AlertDescription>
                    Copy this now. It is not shown again and cannot be recovered
                    - if you lose it, rotate for a new one.
                  </AlertDescription>
                </Alert>
                <CopyableSnippet label="Copy credential" text={token} />
                <Button className="self-start" onClick={() => setToken(null)}>
                  I&apos;ve saved it
                </Button>
              </section>
            )}

            <section className="flex flex-col gap-3">
              <p className="text-sm font-semibold">{content.setupStep}</p>
              {content.fields(status.ingestUrl).map((field) => (
                <div key={field.label} className="flex flex-col gap-1">
                  <p className="text-sm text-muted-foreground">{field.label}</p>
                  <CopyableSnippet
                    label={`Copy ${field.label}`}
                    text={field.value}
                  />
                </div>
              ))}
              {template && (
                <CopyableSnippet label={template.label} text={template.text} />
              )}
            </section>

            {/* Stated where they are set: these fail without reporting. */}
            {content.warnings.map((warning) => (
              <Alert key={warning} variant="warning">
                <TriangleAlert {...ICON_UI} />
                <AlertDescription>{warning}</AlertDescription>
              </Alert>
            ))}

            {configured && !unsaved && (
              <section className="flex flex-col gap-2">
                <p className="text-sm font-semibold">{content.confirmStep}</p>
                {/* Delivery is observed, never probed: the sender dials in, so
                    the status line is the proof. */}
                <p className="text-sm text-muted-foreground">
                  The status line above reports your first delivery.
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    size="xs"
                    variant="secondary"
                    disabled={generate.isPending}
                    onClick={() => setConfirmRotate(true)}
                  >
                    Rotate credential
                  </Button>
                  <Button
                    size="xs"
                    variant="secondary"
                    onClick={() => setConfirmDisconnect(true)}
                  >
                    Disconnect
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

      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title={`Disconnect ${content.label}?`}
        description="The credential stops working immediately and further deliveries are refused. Investigations already open are unaffected."
        confirmLabel="Disconnect"
        destructive
        onConfirm={() => disconnect.mutate()}
      />

      <ConfirmDialog
        open={blocker.status === "blocked"}
        onOpenChange={(o) => {
          if (!o && blocker.status === "blocked") blocker.reset();
        }}
        title="Leave without saving the credential?"
        description="It is not shown again. You would have to rotate to get a working one."
        confirmLabel="Leave"
        destructive
        onConfirm={() => {
          if (blocker.status === "blocked") blocker.proceed();
        }}
      />
    </Page>
  );
}
