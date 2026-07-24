import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type {
  PrometheusIntegrationStatus,
  PrometheusLabelValidation,
  RunnerRecord,
} from "@nightwarden/shared";

import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel, FieldDescription } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Page, PageHeader, PageTitle } from "@/components/layout/Page";
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
  const [validation, setValidation] =
    useState<PrometheusLabelValidation | null>(null);

  const { data: status, isLoading } = useQuery<PrometheusIntegrationStatus>({
    queryKey: ["prometheus-integration"],
    queryFn: () =>
      apiFetch<PrometheusIntegrationStatus>("/api/integrations/prometheus"),
  });

  const { data: runners } = useQuery<RunnerRecord[]>({
    queryKey: ["runners"],
    queryFn: () => apiFetch<RunnerRecord[]>("/api/runners"),
  });
  const connectedRunners = (runners ?? []).filter(
    (r) => r.online && r.hostname !== null,
  );

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

  const test = useMutation({
    mutationFn: () =>
      apiFetch<PrometheusIntegrationStatus>(
        "/api/integrations/prometheus/test",
        { method: "POST" },
      ),
    onSuccess: async () => {
      toast.success("Prometheus responded to a test query");
      await queryClient.invalidateQueries({
        queryKey: ["prometheus-integration"],
      });
    },
    onError: (err) =>
      toast.show({
        title: "Test query failed",
        message: err instanceof Error ? err.message : "Try again.",
        variant: "error",
      }),
  });

  const validateLabels = useMutation({
    mutationFn: () =>
      apiFetch<PrometheusLabelValidation>(
        "/api/integrations/prometheus/validate-labels",
        { method: "POST" },
      ),
    onMutate: () => setValidation(null),
    onSuccess: (result) => setValidation(result),
    onError: (err) =>
      toast.show({
        title: "Could not check labels",
        message: err instanceof Error ? err.message : "Try again.",
        variant: "error",
      }),
  });

  const disconnect = useMutation({
    mutationFn: () =>
      apiFetch<void>("/api/integrations/prometheus", { method: "DELETE" }),
    onSuccess: async () => {
      setValidation(null);
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
                The base URL of your Prometheus, reachable from the NightWarden
                API host. Don&apos;t expose Prometheus to the public internet.
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
          <>
            <section className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium">{status.url}</p>
                <Badge variant="success">Connected</Badge>
                {status.hasAuth && <Badge variant="secondary">Auth</Badge>}
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
                  disabled={test.isPending}
                  onClick={() => test.mutate()}
                >
                  {test.isPending && <Spinner className="size-3" />}
                  Test query
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

            {connectedRunners.length > 0 && (
              <section className="flex flex-col gap-2">
                <p className="text-sm font-semibold">
                  Check alert routing labels
                </p>
                <p className="max-w-3xl text-sm text-muted-foreground">
                  Compares the nw_server label values in your metrics against
                  your runner server names - catches a typo before it costs an
                  investigation.
                </p>
                <Button
                  size="xs"
                  variant="secondary"
                  className="self-start"
                  disabled={validateLabels.isPending}
                  onClick={() => validateLabels.mutate()}
                >
                  {validateLabels.isPending && <Spinner className="size-3" />}
                  Check labels
                </Button>

                {validation !== null && (
                  <div className="flex max-w-3xl flex-col gap-2">
                    {validation.matched.length > 0 && (
                      <Alert>
                        <AlertTitle>Labelled correctly</AlertTitle>
                        <AlertDescription>
                          {validation.matched.join(", ")}
                        </AlertDescription>
                      </Alert>
                    )}
                    {validation.missing.length > 0 && (
                      <Alert variant="destructive">
                        <AlertTitle>No metrics carry these servers</AlertTitle>
                        <AlertDescription>
                          {validation.missing.join(", ")} - add the nw_server
                          label for them on the Alertmanager page.
                        </AlertDescription>
                      </Alert>
                    )}
                    {validation.unknown.length > 0 && (
                      <Alert variant="destructive">
                        <AlertTitle>
                          Labels matching no runner (typo?)
                        </AlertTitle>
                        <AlertDescription>
                          {validation.unknown.join(", ")}
                        </AlertDescription>
                      </Alert>
                    )}
                    {validation.matched.length === 0 &&
                      validation.missing.length === 0 &&
                      validation.unknown.length === 0 && (
                        <Alert>
                          <AlertTitle>No nw_server labels observed</AlertTitle>
                          <AlertDescription>
                            Fine with one server; with several, add the labels
                            from the Alertmanager page.
                          </AlertDescription>
                        </Alert>
                      )}
                  </div>
                )}
              </section>
            )}
          </>
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
