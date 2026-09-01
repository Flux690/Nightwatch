import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SentryIntegrationStatus } from "@nightwarden/shared";

import { Alert, AlertTitle, AlertDescription } from "@/shared/ui/alert";
import { MetaText, StatusText } from "@/shared/ui/status";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Field, FieldLabel, FieldDescription } from "@/shared/ui/field";
import { Spinner } from "@/shared/ui/spinner";
import { Page } from "@/shared/ui/Page";
import { ConfirmDialog } from "@/shared/ui/ConfirmDialog";
import { toast } from "@/shared/lib/toast";
import { dayClock } from "@/shared/lib/time";
import { apiFetch } from "@/shared/api/client";
import { connectMessage, useDisconnect } from "../useIntegration";
import { INTEGRATION_CATALOG } from "../catalog";
import { IntegrationHeader } from "@/features/integrations/IntegrationHeader";

export function SentryPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState("");
  const [orgSlug, setOrgSlug] = useState("");
  const [token, setToken] = useState("");
  const [connectError, setConnectError] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const { data: status, isLoading } = useQuery<SentryIntegrationStatus>({
    queryKey: ["sentry-integration"],
    queryFn: () =>
      apiFetch<SentryIntegrationStatus>("/api/integrations/sentry"),
  });

  const connect = useMutation({
    mutationFn: () =>
      apiFetch<SentryIntegrationStatus>("/api/integrations/sentry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: url.trim(),
          orgSlug: orgSlug.trim(),
          token: token.trim(),
        }),
      }),
    onMutate: () => setConnectError(null),
    onSuccess: async () => {
      setUrl("");
      setOrgSlug("");
      setToken("");
      toast.success("Sentry connected");
      await queryClient.invalidateQueries({ queryKey: ["sentry-integration"] });
    },
    onError: (err) => setConnectError(connectMessage(err)),
  });

  const disconnect = useDisconnect({
    label: "Sentry",
    queryKey: ["sentry-integration"],
    endpoint: () => "/api/integrations/sentry",
  });

  return (
    <Page
      measure="form"
      crumbs={[
        { label: "Integrations", to: "/integrations" },
        { label: "Sentry" },
      ]}
    >
      <div className="flex flex-col gap-8">
        <IntegrationHeader identity={INTEGRATION_CATALOG.sentry} />

        {isLoading && (
          <div className="flex items-center gap-2">
            <Spinner />
            <p className="text-sm text-muted-foreground">Loading...</p>
          </div>
        )}

        {status && !status.configured && (
          <section className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              Where NightWarden reads exceptions and releases from. It dials
              this from its own machine, so the address has to be reachable from
              there. Both sentry.io and a self-hosted Sentry work.
            </p>
            <Field>
              <FieldLabel htmlFor="sentry-url">Sentry URL</FieldLabel>
              <FieldDescription>
                The base address, without the /api/0 path.
              </FieldDescription>
              <Input
                id="sentry-url"
                placeholder="https://sentry.example.com"
                value={url}
                onChange={(e) => setUrl(e.currentTarget.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="sentry-org">Organization slug</FieldLabel>
              <FieldDescription>
                The organization in the URL when you browse Sentry, not its
                display name.
              </FieldDescription>
              <Input
                id="sentry-org"
                measure="short"
                placeholder="acme"
                value={orgSlug}
                onChange={(e) => setOrgSlug(e.currentTarget.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="sentry-token">Auth token</FieldLabel>
              <FieldDescription>
                Create an internal integration in Sentry, under Settings then
                Developer Settings, and grant it both event:read and
                project:read. Issues need the first; releases and commits need
                the second.
              </FieldDescription>
              <Input
                id="sentry-token"
                type="password"
                placeholder="sntrys_..."
                value={token}
                onChange={(e) => setToken(e.currentTarget.value)}
              />
            </Field>

            {connectError !== null && (
              <Alert variant="destructive">
                <AlertTitle>Could not connect</AlertTitle>
                <AlertDescription>{connectError}</AlertDescription>
              </Alert>
            )}

            <Button
              className="self-start"
              disabled={
                url.trim() === "" ||
                orgSlug.trim() === "" ||
                token.trim() === "" ||
                connect.isPending
              }
              onClick={() => connect.mutate()}
            >
              {connect.isPending && <Spinner className="size-4" />}
              Connect
            </Button>
          </section>
        )}

        {status?.configured === true && (
          <section className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium">{status.url}</p>
              <StatusText tone="ok">Connected</StatusText>
              {status.orgSlug !== null && <MetaText>{status.orgSlug}</MetaText>}
            </div>
            {status.validatedAt !== null && (
              <p className="text-sm text-muted-foreground">
                Last verified {dayClock(status.validatedAt)}
              </p>
            )}
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setConfirmDisconnect(true)}
              >
                Disconnect
              </Button>
            </div>
          </section>
        )}
      </div>

      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title="Disconnect Sentry?"
        description="Investigations lose exception and release evidence until it is reconnected."
        confirmLabel="Disconnect"
        destructive
        onConfirm={() => disconnect.mutate()}
      />
    </Page>
  );
}
