import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { RunnerRecord } from "@nightwatch/shared";
import { ArrowLeft } from "lucide-react";

import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
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
import { IngestCredentialSection } from "@/components/layout/IngestCredentialSection";
import { ICON_INLINE } from "@/lib/iconProps";
import { apiFetch } from "@/api/client";

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
        annotations: { summary: "Sample alert from the Alert ingest page" },
        startsAt: new Date().toISOString(),
        endsAt: "0001-01-01T00:00:00Z",
        fingerprint: "alert-ingest-test-webhook",
      },
    ],
  };
}

export function AlertIngestPage(): React.JSX.Element {
  const [serverLabel, setServerLabel] = useState("");
  const [webhookTestResult, setWebhookTestResult] = useState<
    | { ok: true; results: ValidateAlertResult[] }
    | { ok: false; error: string }
    | null
  >(null);

  // Ensuring mints the fleet credential on first view, so the webhook URL and
  // the receiver snippet are copy-ready without a separate setup step.
  const { data: ingest, isLoading } = useQuery<{
    token: string;
    ingestUrl: string;
  }>({
    queryKey: ["ingest-credential-ensure"],
    queryFn: () =>
      apiFetch<{ token: string; ingestUrl: string }>(
        "/api/ingest-credential/ensure",
        { method: "POST" },
      ),
  });

  const { data: runners } = useQuery<RunnerRecord[]>({
    queryKey: ["runners"],
    queryFn: () => apiFetch<RunnerRecord[]>("/api/runners"),
  });

  const firstServerName =
    runners?.find((r) => r.serverName !== null)?.serverName ?? "";
  const effectiveServer = serverLabel.trim() || firstServerName;

  const testWebhook = useMutation({
    mutationFn: async (): Promise<ValidateAlertResult[]> => {
      if (!ingest) throw new Error("Ingest credential is not ready yet");
      const body = await apiFetch<{
        alerts?: ValidateAlertResult[];
        error?: string;
      }>("/api/alerts/validate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ingest.token}`,
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

  return (
    <Page>
      <Link to="/integrations" className={backLinkClass}>
        <ArrowLeft {...ICON_INLINE} />
        Integrations
      </Link>
      <PageHeader>
        <PageTitle>Alert ingest</PageTitle>
      </PageHeader>

      <div className="flex flex-col gap-8">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Nightwatch does not ship a monitoring stack - point the one you
          already run at this endpoint. Set this up once for the whole fleet:
          every server shares one ingest credential, and a per-server label
          tells Nightwatch which server an alert is about.
        </p>

        <IngestCredentialSection />

        {isLoading && (
          <div className="flex items-center gap-2">
            <Spinner />
            <p className="text-sm text-muted-foreground">
              Preparing the webhook details...
            </p>
          </div>
        )}

        {ingest && (
          <>
            <section className="flex flex-col gap-2">
              <p className="text-sm font-semibold">
                In your Alertmanager - forward alerts to Nightwatch
              </p>

              <p className="text-xs text-muted-foreground">Webhook URL</p>
              <CopyableSnippet
                label="Copy webhook URL"
                text={ingest.ingestUrl}
              />

              <p className="text-xs text-muted-foreground">
                Or paste this receiver directly:
              </p>
              <CopyableSnippet
                label="Copy Alertmanager receiver"
                text={[
                  "receivers:",
                  "  - name: nightwatch",
                  "    webhook_configs:",
                  `      - url: '${ingest.ingestUrl}'`,
                  "        http_config:",
                  "          authorization:",
                  "            type: Bearer",
                  `            credentials: '${ingest.token}'`,
                ].join("\n")}
              />
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
                disabled={testWebhook.isPending}
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
                        <span className="block">
                          {result.resolution.reason}
                        </span>
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
