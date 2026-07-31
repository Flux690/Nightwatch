import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { PrometheusIntegrationStatus } from "@nightwarden/shared";

import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { MetaText, StatusText } from "@/components/ui/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel, FieldDescription } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import {
  BackLink,
  Page,
  PageHeader,
  PageTitle,
} from "@/components/layout/Page";
import { ConfirmDialog } from "@/components/layout/ConfirmDialog";
import { toast } from "@/lib/toast";
import { ApiError, apiFetch } from "@/api/client";

export function PrometheusPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [url, setUrl] = useState("");
  const [authHeader, setAuthHeader] = useState("");
  const [connectError, setConnectError] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const { data: status, isLoading } = useQuery<PrometheusIntegrationStatus>({
    queryKey: ["prometheus-integration"],
    queryFn: () =>
      apiFetch<PrometheusIntegrationStatus>("/api/integrations/prometheus"),
  });

  const connect = useMutation({
    mutationFn: () =>
      apiFetch<PrometheusIntegrationStatus>("/api/integrations/prometheus", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: url.trim(),
          ...(authHeader.trim() && { authHeader: authHeader.trim() }),
        }),
      }),
    onMutate: () => setConnectError(null),
    onSuccess: async () => {
      setUrl("");
      setAuthHeader("");
      toast.success("Prometheus connected");
      await queryClient.invalidateQueries({
        queryKey: ["prometheus-integration"],
      });
    },
    onError: (err) =>
      setConnectError(
        err instanceof ApiError ? err.message : "Could not reach the API",
      ),
  });

  const disconnect = useMutation({
    mutationFn: () =>
      apiFetch<void>("/api/integrations/prometheus", { method: "DELETE" }),
    onSuccess: async () => {
      toast.success("Prometheus disconnected");
      await queryClient.invalidateQueries({
        queryKey: ["prometheus-integration"],
      });
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
    <Page>
      <BackLink to="/integrations">Integrations</BackLink>
      <PageHeader>
        <PageTitle>Prometheus</PageTitle>
      </PageHeader>

      <div className="flex flex-col gap-8">
        <p className="max-w-3xl text-sm text-muted-foreground">
          Connect the Prometheus you already run so investigations can query
          your metrics. Read-only, and works with zero runners installed.
        </p>

        {isLoading && (
          <div className="flex items-center gap-2">
            <Spinner />
            <p className="text-sm text-muted-foreground">Loading...</p>
          </div>
        )}

        {status && !status.configured && (
          <section className="flex flex-col gap-4">
            <Field className="max-w-120">
              <FieldLabel htmlFor="prometheus-url">Prometheus URL</FieldLabel>
              <FieldDescription>
                The base URL of your Prometheus. NightWarden connects from its
                own machine, so the address has to work from there, not from
                this browser. Don&apos;t expose Prometheus to the public
                internet.
              </FieldDescription>
              <Input
                id="prometheus-url"
                placeholder="http://prometheus.internal:9090"
                value={url}
                onChange={(e) => setUrl(e.currentTarget.value)}
              />
            </Field>
            <Field className="max-w-120">
              <FieldLabel htmlFor="prometheus-auth">
                Authorization header (optional)
              </FieldLabel>
              <FieldDescription>
                Only if your Prometheus sits behind auth: the full header value,
                sent as-is and stored encrypted.
              </FieldDescription>
              <Input
                id="prometheus-auth"
                type="password"
                placeholder="Bearer ..."
                value={authHeader}
                onChange={(e) => setAuthHeader(e.currentTarget.value)}
              />
            </Field>

            {connectError !== null && (
              <Alert variant="destructive" className="max-w-120">
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
        title="Disconnect Prometheus?"
        description="Investigations lose metric evidence until it is reconnected."
        confirmLabel="Disconnect"
        destructive
        onConfirm={() => disconnect.mutate()}
      />
    </Page>
  );
}
