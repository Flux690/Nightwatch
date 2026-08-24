import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { LokiIntegrationStatus } from "@nightwarden/shared";

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

export function LokiPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState("");
  const [authHeader, setAuthHeader] = useState("");
  const [orgId, setOrgId] = useState("");
  const [connectError, setConnectError] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const { data: status, isLoading } = useQuery<LokiIntegrationStatus>({
    queryKey: ["loki-integration"],
    queryFn: () => apiFetch<LokiIntegrationStatus>("/api/integrations/loki"),
  });

  const connect = useMutation({
    mutationFn: () =>
      apiFetch<LokiIntegrationStatus>("/api/integrations/loki", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: url.trim(),
          ...(authHeader.trim() && { authHeader: authHeader.trim() }),
          ...(orgId.trim() && { orgId: orgId.trim() }),
        }),
      }),
    onMutate: () => setConnectError(null),
    onSuccess: async () => {
      setUrl("");
      setAuthHeader("");
      setOrgId("");
      toast.success("Loki connected");
      await queryClient.invalidateQueries({ queryKey: ["loki-integration"] });
    },
    onError: (err) => setConnectError(connectMessage(err)),
  });

  const disconnect = useDisconnect({
    label: "Loki",
    queryKey: ["loki-integration"],
    endpoint: () => "/api/integrations/loki",
  });

  return (
    <Page
      measure="form"
      crumbs={[
        { label: "Integrations", to: "/integrations" },
        { label: "Loki" },
      ]}
    >
      <div className="flex flex-col gap-8">
        <IntegrationHeader identity={INTEGRATION_CATALOG.loki} />

        {isLoading && (
          <div className="flex items-center gap-2">
            <Spinner />
            <p className="text-sm text-muted-foreground">Loading...</p>
          </div>
        )}

        {status && !status.configured && (
          <section className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              Where NightWarden reads log lines from. It dials this from its own
              machine, so the address has to be reachable from there.
            </p>
            <Field>
              <FieldLabel htmlFor="loki-url">Loki URL</FieldLabel>
              <Input
                id="loki-url"
                placeholder="http://loki.internal:3100"
                value={url}
                onChange={(e) => setUrl(e.currentTarget.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="loki-auth">Authorization header</FieldLabel>
              <FieldDescription>
                The whole header value, scheme included.
              </FieldDescription>
              <Input
                id="loki-auth"
                type="password"
                placeholder="Bearer ..."
                value={authHeader}
                onChange={(e) => setAuthHeader(e.currentTarget.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="loki-org">Tenant</FieldLabel>
              <FieldDescription>
                The tenant to read, sent as X-Scope-OrgID.
              </FieldDescription>
              <Input
                id="loki-org"
                measure="short"
                placeholder="my-tenant"
                value={orgId}
                onChange={(e) => setOrgId(e.currentTarget.value)}
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
              disabled={url.trim() === "" || connect.isPending}
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
              {status.hasAuth && <MetaText>Auth</MetaText>}
              {status.hasOrgId && <MetaText>Tenant</MetaText>}
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
        title="Disconnect Loki?"
        description="Investigations lose log evidence until it is reconnected."
        confirmLabel="Disconnect"
        destructive
        onConfirm={() => disconnect.mutate()}
      />
    </Page>
  );
}
