import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { LokiIntegrationStatus } from "@nightwarden/shared";

import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { MetaText, StatusText } from "@/components/ui/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel, FieldDescription } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Page } from "@/components/layout/Page";
import { ConfirmDialog } from "@/components/layout/ConfirmDialog";
import { toast } from "@/lib/toast";
import { ApiError, apiFetch } from "@/api/client";
import { INTEGRATION_CATALOG } from "./integrationCatalog";
import { IntegrationHeader } from "@/components/layout/IntegrationHeader";

export function LokiPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
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
    onError: (err) =>
      setConnectError(
        err instanceof ApiError ? err.message : "Could not reach the API",
      ),
  });

  const disconnect = useMutation({
    mutationFn: () =>
      apiFetch<void>("/api/integrations/loki", { method: "DELETE" }),
    onSuccess: async () => {
      toast.success("Loki disconnected");
      await queryClient.invalidateQueries({ queryKey: ["loki-integration"] });
      void navigate({ to: "/integrations" });
    },
    onError: (err) =>
      toast.show({
        title: "Could not disconnect",
        message: err instanceof Error ? err.message : "Try again.",
        variant: "error",
      }),
  });

  return (
    <Page
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
            <Field>
              <FieldLabel htmlFor="loki-url">Loki URL</FieldLabel>
              <FieldDescription>
                NightWarden dials this from its own machine, so it must be
                reachable from there.
              </FieldDescription>
              <Input
                className="max-w-control"
                id="loki-url"
                placeholder="http://loki.internal:3100"
                value={url}
                onChange={(e) => setUrl(e.currentTarget.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="loki-auth">
                Authorization header (optional)
              </FieldLabel>
              <FieldDescription>
                Add this only if your Loki sits behind authentication.
              </FieldDescription>
              <Input
                className="max-w-control"
                id="loki-auth"
                type="password"
                placeholder="Bearer ..."
                value={authHeader}
                onChange={(e) => setAuthHeader(e.currentTarget.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="loki-org">Tenant ID (optional)</FieldLabel>
              <FieldDescription>
                Multi-tenant Loki needs a tenant here; single-tenant Loki does
                not.
              </FieldDescription>
              <Input
                className="max-w-control"
                id="loki-org"
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
                Last verified {new Date(status.validatedAt).toLocaleString()}
              </p>
            )}
            <div className="flex items-center gap-2">
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
