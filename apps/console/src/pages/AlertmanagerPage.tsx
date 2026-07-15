import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { RunnerRecord } from "@nightwatch/shared";
import { ArrowLeft, X } from "lucide-react";

import {
  Alert,
  AlertTitle,
  AlertDescription,
  AlertAction,
} from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel, FieldDescription } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import {
  Page,
  PageHeader,
  PageTitle,
  backLinkClass,
} from "@/components/layout/Page";
import { CopyableSnippet } from "@/components/layout/CopyableSnippet";
import { ICON_INLINE, ICON_UI } from "@/lib/iconProps";
import { toast } from "@/lib/toast";
import { apiFetch } from "@/api/client";

interface CredentialStatus {
  configured: boolean;
  ingestUrl: string;
}

interface ValidateAlertResult {
  sourceAlertId: string;
  identityKey: string;
  resolution:
    | { status: "resolved"; runnerId: string; hostname: string }
    | { status: "rejected"; reason: string };
}

function sampleWebhookPayload(serverName: string): unknown {
  return {
    alerts: [
      {
        status: "firing",
        labels: {
          alertname: "TestAlert",
          severity: "warning",
          container: "sample-service",
          ...(serverName && { server: serverName }),
        },
        annotations: { summary: "Sample alert from the Alertmanager page" },
        startsAt: new Date().toISOString(),
        endsAt: "0001-01-01T00:00:00Z",
        fingerprint: "alertmanager-test-webhook",
      },
    ],
  };
}

function receiverSnippet(ingestUrl: string, token: string): string {
  return [
    "receivers:",
    "  - name: nightwatch",
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
  const [serverLabel, setServerLabel] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [tokenFresh, setTokenFresh] = useState(false);
  const [webhookTestResult, setWebhookTestResult] = useState<
    | { ok: true; results: ValidateAlertResult[] }
    | { ok: false; error: string }
    | null
  >(null);

  const { data: status, isLoading } = useQuery<CredentialStatus>({
    queryKey: ["ingest-credential"],
    queryFn: () => apiFetch<CredentialStatus>("/api/ingest-credential"),
  });

  const { data: runners } = useQuery<RunnerRecord[]>({
    queryKey: ["runners"],
    queryFn: () => apiFetch<RunnerRecord[]>("/api/runners"),
  });

  const firstServerName =
    runners?.find((r) => r.serverName !== null)?.serverName ?? "";
  const effectiveServer = serverLabel.trim() || firstServerName;

  const generate = useMutation({
    mutationFn: () =>
      apiFetch<{ token: string }>("/api/ingest-credential", { method: "POST" }),
    onSuccess: async ({ token: minted }) => {
      setToken(minted);
      setTokenFresh(true);
      setWebhookTestResult(null);
      await queryClient.invalidateQueries({ queryKey: ["ingest-credential"] });
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
      apiFetch<{ token: string }>("/api/ingest-credential/reveal", {
        method: "POST",
      }),
    onSuccess: ({ token: revealed }) => {
      setToken(revealed);
      setTokenFresh(false);
    },
    onError: (err) =>
      toast.show({
        title: "Could not reveal credential",
        message: err instanceof Error ? err.message : "Try again.",
        variant: "error",
      }),
  });

  const testWebhook = useMutation({
    mutationFn: async (): Promise<ValidateAlertResult[]> => {
      if (token === null) throw new Error("Reveal the credential first");
      const body = await apiFetch<{
        alerts?: ValidateAlertResult[];
        error?: string;
      }>("/api/alerts/validate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(sampleWebhookPayload(effectiveServer)),
      });
      if (!body.alerts) throw new Error(body.error ?? "Test webhook failed");
      return body.alerts;
    },
    onMutate: () => setWebhookTestResult(null),
    onSuccess: (results) => setWebhookTestResult({ ok: true, results }),
    onError: (err) =>
      setWebhookTestResult({
        ok: false,
        error: err instanceof Error ? err.message : "Failed to test webhook",
      }),
  });

  const busy = generate.isPending || reveal.isPending;

  return (
    <Page>
      <Link to="/integrations" className={backLinkClass}>
        <ArrowLeft {...ICON_INLINE} />
        Integrations
      </Link>
      <PageHeader>
        <PageTitle>Alertmanager</PageTitle>
      </PageHeader>

      <div className="flex flex-col gap-8">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Nightwatch does not ship a monitoring stack - forward alerts from the
          Alertmanager you already run. Set this up once for the whole fleet:
          every server shares one credential, and a per-server label tells
          Nightwatch which server an alert is about.
        </p>

        {isLoading && (
          <div className="flex items-center gap-2">
            <Spinner />
            <p className="text-sm text-muted-foreground">Loading...</p>
          </div>
        )}

        {status && (
          <>
            <section className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium">Ingest credential</p>
                {status.configured ? (
                  <Badge variant="success">Configured</Badge>
                ) : (
                  <Badge variant="secondary">Not configured</Badge>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="xs"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => generate.mutate()}
                >
                  {generate.isPending && <Spinner className="size-3" />}
                  {status.configured
                    ? "Rotate credential"
                    : "Generate credential"}
                </Button>
                {status.configured && (
                  <Button
                    size="xs"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => reveal.mutate()}
                  >
                    {reveal.isPending && <Spinner className="size-3" />}
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
                    <CopyableSnippet
                      text={token}
                      label="Copy ingest credential"
                    />
                  </AlertDescription>
                  <AlertAction>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Dismiss"
                      onClick={() => setToken(null)}
                    >
                      <X {...ICON_UI} />
                    </Button>
                  </AlertAction>
                </Alert>
              )}
            </section>

            <section className="flex flex-col gap-2">
              <p className="text-sm font-semibold">
                In your Alertmanager - forward alerts to Nightwatch
              </p>

              <p className="text-xs text-muted-foreground">Webhook URL</p>
              <CopyableSnippet
                label="Copy webhook URL"
                text={status.ingestUrl}
              />

              {token === null ? (
                <p className="text-xs text-muted-foreground">
                  {status.configured
                    ? "Reveal the credential to fill in the receiver below."
                    : "Generate the credential to fill in the receiver below."}
                </p>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground">
                    Or paste this receiver directly:
                  </p>
                  <CopyableSnippet
                    label="Copy Alertmanager receiver"
                    text={receiverSnippet(status.ingestUrl, token)}
                  />
                </>
              )}
            </section>

            <section className="flex flex-col gap-2">
              <p className="text-sm font-semibold">
                In your Prometheus - stamp the server label
              </p>
              <Field className="max-w-80">
                <FieldLabel htmlFor="server-label">Server</FieldLabel>
                <FieldDescription>
                  The name of the server this Prometheus scrapes, exactly as it
                  appears in your runner servers list.
                </FieldDescription>
                <Input
                  id="server-label"
                  placeholder={firstServerName || "e.g. prod-web-01"}
                  value={serverLabel}
                  onChange={(e) => setServerLabel(e.currentTarget.value)}
                />
              </Field>
              {effectiveServer && (
                <CopyableSnippet
                  label="Copy Prometheus config"
                  text={[
                    "global:",
                    "  external_labels:",
                    `    server: "${effectiveServer}"`,
                  ].join("\n")}
                />
              )}
            </section>

            <section className="flex flex-col gap-2">
              <Button
                size="xs"
                variant="secondary"
                className="self-start"
                disabled={token === null || testWebhook.isPending}
                onClick={() => testWebhook.mutate()}
              >
                {testWebhook.isPending && <Spinner className="size-3" />}
                Test webhook
              </Button>

              {webhookTestResult?.ok === true &&
                webhookTestResult.results.map((result) => (
                  <Alert
                    key={result.sourceAlertId}
                    variant={
                      result.resolution.status === "resolved"
                        ? undefined
                        : "destructive"
                    }
                  >
                    <AlertTitle>
                      {result.resolution.status === "resolved"
                        ? "Resolved"
                        : "Rejected"}
                    </AlertTitle>
                    <AlertDescription>
                      <span className="block">{result.identityKey}</span>
                      {result.resolution.status === "resolved" ? (
                        <span className="block">
                          Would route to {result.resolution.hostname}.
                        </span>
                      ) : (
                        <span className="block">{result.resolution.reason}</span>
                      )}
                    </AlertDescription>
                  </Alert>
                ))}
              {webhookTestResult?.ok === false && (
                <Alert variant="destructive">
                  <AlertTitle>Test webhook failed</AlertTitle>
                  <AlertDescription>{webhookTestResult.error}</AlertDescription>
                </Alert>
              )}
            </section>
          </>
        )}
      </div>
    </Page>
  );
}
