import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { RunnerRecord } from "@nightwatch/shared";
import { ArrowLeft, ChevronDown } from "lucide-react";

import {
  Alert,
  AlertTitle,
  AlertDescription,
} from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Field, FieldLabel, FieldDescription } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import {
  Page,
  PageHeader,
  PageTitle,
  backLinkClass,
} from "@/components/layout/Page";
import { CopyableSnippet } from "@/components/layout/CopyableSnippet";
import { ICON_INLINE } from "@/lib/iconProps";
import { toast } from "@/lib/toast";
import { apiFetch } from "@/api/client";

interface CredentialStatus {
  configured: boolean;
  ingestUrl: string;
  lastReceivedAt: string | null;
}

// The API's real /alerts/validate shape: an advisory fleet match per alert.
interface ValidateAlertResult {
  sourceAlertId: string;
  identityKey: string;
  advertisedOn: string[];
  exactMatch: boolean;
}

const MASKED_TOKEN = "nwi_ ••••••••";

function sampleWebhookPayload(serverName: string): unknown {
  return {
    alerts: [
      {
        status: "firing",
        labels: {
          alertname: "TestAlert",
          severity: "warning",
          container: "sample-service",
          ...(serverName && { nw_server: serverName }),
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

function perTargetSnippet(name: string): string {
  return [
    "scrape_configs:",
    `  - job_name: node               # each job that scrapes ${name}`,
    "    static_configs:",
    '      - targets: ["10.0.0.5:9100"]   # your existing target line',
    "        labels:",
    `          nw_server: "${name}"`,
  ].join("\n");
}

function externalLabelsSnippet(name: string): string {
  return ["global:", "  external_labels:", `    nw_server: "${name}"`].join(
    "\n",
  );
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function AlertmanagerPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [token, setToken] = useState<string | null>(null);
  const [selectedServer, setSelectedServer] = useState("");
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

  const connected = (runners ?? []).filter(
    (r) => r.online && r.hostname !== null,
  );
  const dockerServers = connected
    .filter((r) => r.manifest?.capabilities.docker === true)
    .map((r) => r.serverName ?? r.hostname ?? r.id);
  const k8sRunnerCount = connected.filter(
    (r) => r.manifest?.capabilities.kubernetes === true,
  ).length;
  const effectiveServer = selectedServer || (dockerServers[0] ?? "");

  const generate = useMutation({
    mutationFn: () =>
      apiFetch<{ token: string }>("/api/ingest-credential", { method: "POST" }),
    onSuccess: async ({ token: minted }, _vars, _ctx) => {
      const rotating = status?.configured === true;
      setToken(minted);
      setWebhookTestResult(null);
      if (rotating) {
        toast.show({
          title: "New credential issued",
          message:
            "The previous one no longer works - paste the updated receiver into your Alertmanager.",
          variant: "info",
        });
      }
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
    onSuccess: ({ token: revealed }) => setToken(revealed),
    onError: (err) =>
      toast.show({
        title: "Could not show the token",
        message: err instanceof Error ? err.message : "Try again.",
        variant: "error",
      }),
  });

  const testWebhook = useMutation({
    mutationFn: async (): Promise<ValidateAlertResult[]> => {
      if (token === null) throw new Error("Show the token first");
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
          Alertmanager you already run. One credential for the whole fleet, set
          up once.
        </p>

        {isLoading && (
          <div className="flex items-center gap-2">
            <Spinner />
            <p className="text-sm text-muted-foreground">Loading...</p>
          </div>
        )}

        {status && !status.configured && (
          <section className="flex flex-col gap-3">
            <Button
              className="self-start"
              disabled={busy}
              onClick={() => generate.mutate()}
            >
              {generate.isPending && <Spinner className="size-4" />}
              Set up alert forwarding
            </Button>
          </section>
        )}

        {status?.configured === true && (
          <>
            <section className="flex items-center gap-2">
              {status.lastReceivedAt !== null ? (
                <>
                  <Badge variant="success">Receiving</Badge>
                  <p className="text-sm text-muted-foreground">
                    last alert {relativeTime(status.lastReceivedAt)}
                  </p>
                </>
              ) : (
                <>
                  <Badge variant="secondary">Waiting for first alert</Badge>
                  <p className="text-sm text-muted-foreground">
                    Paste the receiver below, then let a real alert (or the
                    test webhook) prove the pipe.
                  </p>
                </>
              )}
            </section>

            <section className="flex flex-col gap-2">
              <p className="text-sm font-semibold">
                In your alertmanager.yml - forward alerts to Nightwatch
              </p>
              {token !== null ? (
                <CopyableSnippet
                  label="Copy Alertmanager receiver"
                  text={receiverSnippet(status.ingestUrl, token)}
                />
              ) : (
                <>
                  <pre className="max-h-60 overflow-auto rounded-lg border border-border bg-muted/30 p-3 font-mono text-xs whitespace-pre-wrap break-all">
                    {receiverSnippet(status.ingestUrl, MASKED_TOKEN)}
                  </pre>
                  <Button
                    size="xs"
                    variant="secondary"
                    className="self-start"
                    disabled={busy}
                    onClick={() => reveal.mutate()}
                  >
                    {reveal.isPending && <Spinner className="size-3" />}
                    Show token
                  </Button>
                </>
              )}
              <div className="mt-2 flex items-center gap-2">
                <Button
                  size="xs"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => generate.mutate()}
                >
                  {generate.isPending && <Spinner className="size-3" />}
                  Rotate credential
                </Button>
                <p className="text-xs text-muted-foreground">
                  Your Alertmanager stops delivering until you paste the new
                  config.
                </p>
              </div>
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
              {token === null && (
                <p className="text-xs text-muted-foreground">
                  Show the token to enable the test.
                </p>
              )}

              {webhookTestResult?.ok === true &&
                webhookTestResult.results.map((result) => (
                  <Alert key={result.sourceAlertId}>
                    <AlertTitle>
                      {result.exactMatch
                        ? "Resolved to one server"
                        : "No exact match"}
                    </AlertTitle>
                    <AlertDescription>
                      <span className="block">{result.identityKey}</span>
                      <span className="block">
                        {result.advertisedOn.length > 0
                          ? `Advertised on ${result.advertisedOn.join(", ")}.`
                          : "No runner advertises this identity - the agent triages it from the fleet map."}
                      </span>
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

            {dockerServers.length === 1 && (
              <p className="max-w-2xl text-xs text-muted-foreground">
                One server - alerts resolve to it automatically. When you add a
                second, come back here to label which server each alert is
                about.
              </p>
            )}

            {dockerServers.length >= 2 && (
              <section className="flex flex-col gap-2">
                <p className="text-sm font-semibold">
                  Make your alerts say which server they&apos;re about
                </p>
                <p className="max-w-2xl text-xs text-muted-foreground">
                  With {dockerServers.length} servers, the same service can run
                  in two places. Add an nw_server label per scrape target in
                  your Prometheus so every alert carries its server.
                </p>
                <Field className="max-w-80">
                  <FieldLabel htmlFor="server-select">Server</FieldLabel>
                  <FieldDescription>
                    Names come from your connected runners.
                  </FieldDescription>
                  <NativeSelect
                    id="server-select"
                    value={effectiveServer}
                    onChange={(e) => setSelectedServer(e.currentTarget.value)}
                  >
                    {dockerServers.map((name) => (
                      <NativeSelectOption key={name} value={name}>
                        {name}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
                <CopyableSnippet
                  label="Copy Prometheus labels"
                  text={perTargetSnippet(effectiveServer)}
                />
                <Collapsible>
                  <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                    <ChevronDown {...ICON_INLINE} />
                    This Prometheus only monitors {effectiveServer}? Set it
                    once instead
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="pt-2">
                      <CopyableSnippet
                        label="Copy external_labels"
                        text={externalLabelsSnippet(effectiveServer)}
                      />
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              </section>
            )}

            {k8sRunnerCount >= 2 && (
              <section className="flex flex-col gap-2">
                <p className="text-sm font-semibold">
                  Multiple Kubernetes clusters
                </p>
                <p className="max-w-2xl text-xs text-muted-foreground">
                  Give each cluster&apos;s alerts a cluster label (in that
                  cluster&apos;s Prometheus external_labels) and set
                  NIGHTWATCH_CLUSTER_NAME to the same value on its runner.
                </p>
                <CopyableSnippet
                  label="Copy cluster external_labels"
                  text={[
                    "global:",
                    "  external_labels:",
                    '    cluster: "prod-cluster"',
                  ].join("\n")}
                />
              </section>
            )}
          </>
        )}
      </div>
    </Page>
  );
}
