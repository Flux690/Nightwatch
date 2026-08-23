import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useBlocker, useNavigate } from "@tanstack/react-router";
import type { AlertSourceKind } from "@nightwarden/shared";

import { Button } from "@/components/ui/button";
import { FieldDescription, FieldTitle } from "@/components/ui/field";
import { StatusText } from "@/components/ui/status";
import { Spinner } from "@/components/ui/spinner";
import { Page } from "@/components/layout/Page";
import { ConfirmDialog } from "@/components/layout/ConfirmDialog";
import { CopyableSnippet } from "@/components/layout/CopyableSnippet";
import { IntegrationHeader } from "@/components/layout/IntegrationHeader";
import { IntegrationWarnings } from "@/components/layout/IntegrationWarnings";
import { timeAgo } from "@/lib/time";
import { toast } from "@/lib/toast";
import { apiFetch } from "@/api/client";
import { ALERT_SOURCE_CONTENT, SECRET_MASK } from "./alertSourceContent";
import { INTEGRATION_CATALOG } from "./integrationCatalog";

interface CredentialStatus {
  configured: boolean;
  ingestUrl: string;
  lastReceivedAt: string | null;
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  /* Not a Field: a Field stretches whatever it holds to the column, which is
     right for an input and wrong for the button that stands where the secret
     will be. The label is the Field's own, so the wording matches. */
  return (
    <div className="flex flex-col gap-2">
      <FieldTitle>{label}</FieldTitle>
      {children}
    </div>
  );
}

export function AlertSourcePage({
  kind,
}: {
  kind: AlertSourceKind;
}): React.JSX.Element {
  const content = ALERT_SOURCE_CONTENT[kind];
  const identity = INTEGRATION_CATALOG[kind];
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // Set only by a mint, cleared only by the user saying they have copied it.
  // Nothing can put it back: the API keeps no readable copy.
  const [secret, setSecret] = useState<string | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const base = `/api/integrations/alerting/${kind}`;
  // Keyed by kind: two senders are two credentials with two status lines, and a
  // shared key would show one sender's delivery proof on the other's page.
  const queryKey = ["alert-source", kind];

  const { data: status, isLoading } = useQuery<CredentialStatus>({
    queryKey,
    queryFn: () => apiFetch<CredentialStatus>(base),
  });

  const unsaved = secret !== null;
  const blocker = useBlocker({
    shouldBlockFn: () => true,
    disabled: !unsaved,
    enableBeforeUnload: () => unsaved,
    withResolver: true,
  });

  const generate = useMutation({
    mutationFn: () =>
      apiFetch<{ token: string }>(`${base}/credential`, { method: "POST" }),
    onSuccess: async ({ token }) => {
      setSecret(token);
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: (err) =>
      toast.show({
        title: "Could not generate the secret",
        message: err instanceof Error ? err.message : "Try again.",
        variant: "error",
      }),
  });

  const disconnect = useMutation({
    mutationFn: () => apiFetch<void>(base, { method: "DELETE" }),
    onSuccess: async () => {
      toast.success(`${identity.label} disconnected`);
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

  return (
    <Page
      measure="form"
      crumbs={[
        { label: "Integrations", to: "/integrations" },
        { label: identity.label },
      ]}
      /* Withheld while a freshly minted secret is on screen: that moment is a
         step to finish, not a delivery report to read. */
      controls={
        configured && !unsaved && status ? (
          <StatusText tone={status.lastReceivedAt !== null ? "ok" : "muted"}>
            {status.lastReceivedAt !== null
              ? `Receiving - last alert ${timeAgo(status.lastReceivedAt)} ago`
              : "Waiting for first alert"}
          </StatusText>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-8">
        <IntegrationHeader identity={identity} />

        {isLoading && (
          <div className="flex items-center gap-2">
            <Spinner />
            <p className="text-sm text-muted-foreground">Loading...</p>
          </div>
        )}

        {status && (
          <>
            <p className="text-sm">{content.where}</p>

            {/* Three rows in a fixed order that never reflows. Only the secret
                row changes state, so nothing moves under whoever is copying. */}
            <section className="flex flex-col gap-4">
              <Row label="Webhook URL">
                <CopyableSnippet
                  label="Copy the webhook URL"
                  text={status.ingestUrl}
                />
              </Row>

              <Row label="Secret">
                {secret !== null ? (
                  <div className="flex flex-col gap-3">
                    <CopyableSnippet label="Copy the secret" text={secret} />
                    <FieldDescription>
                      Copy it now. It is not shown again and cannot be
                      recovered; if you lose it, rotate for a new one.
                    </FieldDescription>
                    <Button
                      className="self-start"
                      onClick={() => setSecret(null)}
                    >
                      I&apos;ve saved it
                    </Button>
                  </div>
                ) : configured ? (
                  <div className="flex flex-col gap-3">
                    <CopyableSnippet
                      label="The secret is not shown again"
                      text={SECRET_MASK}
                      copyable={false}
                    />
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={generate.isPending}
                        onClick={() => setConfirmRotate(true)}
                      >
                        Rotate
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setConfirmDisconnect(true)}
                      >
                        Disconnect
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    className="self-start"
                    disabled={generate.isPending}
                    onClick={() => generate.mutate()}
                  >
                    {generate.isPending && <Spinner className="size-4" />}
                    Generate secret
                  </Button>
                )}
              </Row>
            </section>

            {/* Stated where they are set: these fail without reporting. */}
            <IntegrationWarnings warnings={content.warnings} />
          </>
        )}
      </div>

      <ConfirmDialog
        open={confirmRotate}
        onOpenChange={setConfirmRotate}
        title="Rotate the secret?"
        description={content.rotateDescription}
        confirmLabel="Rotate"
        destructive
        onConfirm={() => generate.mutate()}
      />

      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title={`Disconnect ${identity.label}?`}
        description="The secret stops working immediately and further deliveries are refused. Investigations already open are unaffected."
        confirmLabel="Disconnect"
        destructive
        onConfirm={() => disconnect.mutate()}
      />

      <ConfirmDialog
        open={blocker.status === "blocked"}
        onOpenChange={(o) => {
          if (!o && blocker.status === "blocked") blocker.reset();
        }}
        title="Leave without saving the secret?"
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
