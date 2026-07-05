import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useBlocker, useNavigate } from "@tanstack/react-router";
import type { RunnerRecord } from "@nightwatch/shared";
import { AlertCircle, ArrowLeft } from "lucide-react";

import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldLabel,
  FieldDescription,
  FieldError,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import {
  Page,
  PageHeader,
  PageTitle,
  backLinkClass,
} from "@/components/layout/Page";
import {
  WizardStepper,
  WizardActions,
} from "@/components/layout/WizardStepper";
import { ConfirmDialog } from "@/components/layout/ConfirmDialog";
import { CopyableSnippet } from "@/components/layout/CopyableSnippet";
import { ICON_INLINE } from "@/lib/iconProps";
import { ApiError, apiFetch } from "@/api/client";
import { WizardMonitoringStep } from "@/pages/WizardMonitoringStep";

export type Provider = "docker" | "kubernetes";
type Monitoring = "bundled" | "byo";

interface MintedToken {
  id: string;
  token: string;
}

const RUNNER_POLL_MS = 3000;

const STEP_TITLES = [
  "Server details",
  "Install the runner",
  "Verify the pipeline",
];

function validateServerName(name: string): string | null {
  if (name.trim().length === 0) return "Server name is required";
  if (name.includes("/")) return "Server name must not contain '/'";
  return null;
}

export function AddServerPage(): React.JSX.Element {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [provider, setProvider] = useState<Provider | null>(null);
  const [serverName, setServerName] = useState("");
  const [serverNameTouched, setServerNameTouched] = useState(false);
  const [monitoring, setMonitoring] = useState<Monitoring | null>(null);
  const [minting, setMinting] = useState(false);
  const [mintedToken, setMintedToken] = useState<MintedToken | null>(null);
  const [installText, setInstallText] = useState<string | null>(null);
  const [ingestToken, setIngestToken] = useState<string | null>(null);
  const [ingestUrl, setIngestUrl] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [committed, setCommitted] = useState(false);
  const [verifyResult, setVerifyResult] = useState<
    { ok: true; hostname: string } | { ok: false; error: string } | null
  >(null);

  const serverNameError = serverName.includes("/")
    ? "Server name must not contain '/'"
    : serverNameTouched && serverName.trim().length === 0
      ? "Server name is required"
      : null;
  const canContinueFromServer =
    provider !== null &&
    monitoring !== null &&
    validateServerName(serverName) === null;

  const { data: runners } = useQuery<RunnerRecord[]>({
    queryKey: ["wizard-runners"],
    queryFn: () => apiFetch<RunnerRecord[]>("/api/runners"),
    enabled: step === 1 && mintedToken !== null,
    refetchInterval: step === 1 ? RUNNER_POLL_MS : false,
  });

  const connectedRunner = runners?.find(
    (r) => r.token === mintedToken?.id && r.online && r.hostname !== null,
  );

  useEffect(() => {
    if (connectedRunner) setCommitted(true);
  }, [connectedRunner]);

  const tokenPending = mintedToken !== null && !committed;
  const blocker = useBlocker({
    shouldBlockFn: () => true,
    disabled: !tokenPending,
    enableBeforeUnload: () => tokenPending,
    withResolver: true,
  });

  function confirmLeaveSetup(): void {
    if (mintedToken !== null) {
      void apiFetch<void>(`/api/tokens/${mintedToken.id}`, {
        method: "DELETE",
      }).catch(() => {});
    }
    if (blocker.status === "blocked") blocker.proceed();
  }

  function cancelLeaveSetup(): void {
    if (blocker.status === "blocked") blocker.reset();
  }

  async function handleStartInstall(): Promise<void> {
    if (!canContinueFromServer) return;
    setStep(1);
    setMinting(true);
    setInstallError(null);
    try {
      const minted = await apiFetch<MintedToken>("/api/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverName: serverName.trim() }),
      });
      setMintedToken(minted);

      const installUrl =
        provider === "docker" ? "/api/connect.sh" : "/api/manifest.yaml";
      const [scriptText, ingest] = await Promise.all([
        fetch(installUrl, {
          headers: { Authorization: `Bearer ${minted.token}` },
        }).then(async (res) => {
          if (!res.ok) throw new Error(`${installUrl} ${res.status}`);
          return res.text();
        }),
        monitoring === "byo"
          ? apiFetch<{ token: string; ingestUrl: string }>(
              "/api/ingest-credential/ensure",
              { method: "POST" },
            )
          : Promise.resolve(null),
      ]);
      setInstallText(scriptText);
      if (ingest) {
        setIngestToken(ingest.token);
        setIngestUrl(ingest.ingestUrl);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setInstallError(err.message);
        setStep(0);
        return;
      }
      setInstallError(
        err instanceof Error ? err.message : "Failed to prepare install",
      );
    } finally {
      setMinting(false);
    }
  }

  const sendTestAlert = useMutation({
    mutationFn: async (runnerId: string): Promise<string> => {
      const body = await apiFetch<{ hostname?: string; error?: string }>(
        "/api/alerts/test",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runnerId }),
        },
      );
      if (!body.hostname)
        throw new Error(body.error ?? "Failed to send test alert");
      return body.hostname;
    },
    onMutate: () => setVerifyResult(null),
    onSuccess: (hostname) => setVerifyResult({ ok: true, hostname }),
    onError: (err) =>
      setVerifyResult({
        ok: false,
        error: err instanceof Error ? err.message : "Failed to send test alert",
      }),
  });

  const trimmedServerName = serverName.trim();

  return (
    <Page>
      <Link to="/fleet" className={backLinkClass}>
        <ArrowLeft {...ICON_INLINE} />
        Fleet
      </Link>
      <PageHeader>
        <PageTitle>Add a server</PageTitle>
      </PageHeader>

      <WizardStepper step={step} total={3} title={STEP_TITLES[step]} />

      {step === 0 && (
        <div className="flex flex-col gap-8">
          <Field>
            <FieldLabel>Which substrate is this server running?</FieldLabel>
            <RadioGroup
              className="mt-2 flex flex-row gap-6"
              value={provider ?? ""}
              onValueChange={(v) => setProvider(v as Provider)}
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem value="docker" id="provider-docker" />
                <Label htmlFor="provider-docker" className="font-normal">
                  Docker
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="kubernetes" id="provider-kubernetes" />
                <Label htmlFor="provider-kubernetes" className="font-normal">
                  Kubernetes
                </Label>
              </div>
            </RadioGroup>
          </Field>

          <Field className="max-w-80">
            <FieldLabel htmlFor="server-name">Server name</FieldLabel>
            <FieldDescription>
              A unique name for this server in your fleet. Immutable once
              installed.
            </FieldDescription>
            <Input
              id="server-name"
              placeholder="e.g. prod-web-01"
              value={serverName}
              aria-invalid={serverNameError !== null}
              onChange={(e) => setServerName(e.currentTarget.value)}
              onBlur={() => setServerNameTouched(true)}
            />
            {serverNameError && (
              <FieldError>
                <AlertCircle {...ICON_INLINE} />
                {serverNameError}
              </FieldError>
            )}
          </Field>

          <Field>
            <FieldLabel>Monitoring</FieldLabel>
            <FieldDescription>
              Nightwatch needs Prometheus and Alertmanager to receive alerts.
            </FieldDescription>
            <RadioGroup
              className="mt-2 gap-2"
              value={monitoring ?? ""}
              onValueChange={(v) => setMonitoring(v as Monitoring)}
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem value="bundled" id="monitoring-bundled" />
                <Label htmlFor="monitoring-bundled" className="font-normal">
                  Bundle Prometheus + Alertmanager for me
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="byo" id="monitoring-byo" />
                <Label htmlFor="monitoring-byo" className="font-normal">
                  I already run my own monitoring
                </Label>
              </div>
            </RadioGroup>
          </Field>

          {installError !== null && (
            <FieldError>
              <AlertCircle {...ICON_INLINE} />
              {installError}
            </FieldError>
          )}

          <WizardActions>
            <Button
              className="ml-auto"
              disabled={!canContinueFromServer}
              onClick={() => void handleStartInstall()}
            >
              Continue
            </Button>
          </WizardActions>
        </div>
      )}

      {step === 1 && (
        <div className="flex flex-col gap-4">
          {minting && (
            <div className="flex items-center gap-2">
              <Spinner />
              <p className="text-sm text-muted-foreground">
                Generating a runner token...
              </p>
            </div>
          )}

          {installError !== null && (
            <FieldError>
              <AlertCircle {...ICON_INLINE} />
              {installError}
            </FieldError>
          )}

          {installText !== null && (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <p className="text-sm">
                  Run this on the target server to install the runner:
                </p>
                <CopyableSnippet
                  text={installText}
                  label="Copy install command"
                />
              </div>

              {monitoring === "bundled" && (
                <Alert>
                  <AlertTitle>Monitoring bundled</AlertTitle>
                  <AlertDescription>
                    Prometheus, Alertmanager and cAdvisor ship inside the runner
                    and are wired to Nightwatch automatically. Nothing else to
                    configure.
                  </AlertDescription>
                </Alert>
              )}

              {monitoring === "byo" &&
                provider &&
                ingestToken !== null &&
                ingestUrl !== null && (
                  <WizardMonitoringStep
                    provider={provider}
                    trimmedServerName={trimmedServerName}
                    ingestToken={ingestToken}
                    ingestUrl={ingestUrl}
                  />
                )}

              <div className="flex items-center gap-2">
                {connectedRunner ? (
                  <Badge variant="success">Runner connected</Badge>
                ) : (
                  <div className="flex items-center gap-2">
                    <Spinner />
                    <p className="text-sm text-muted-foreground">
                      Waiting for the runner to connect...
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}

          <WizardActions>
            <Button variant="outline" onClick={() => setStep(0)}>
              Back
            </Button>
            <Button disabled={!connectedRunner} onClick={() => setStep(2)}>
              Continue
            </Button>
          </WizardActions>
        </div>
      )}

      {step === 2 && (
        <div className="flex flex-col gap-4">
          <p className="text-sm">
            Send a synthetic alert through the full pipeline to confirm it
            reaches this server.
          </p>

          <Button
            className="self-start"
            disabled={!connectedRunner || sendTestAlert.isPending}
            onClick={() =>
              connectedRunner && sendTestAlert.mutate(connectedRunner.id)
            }
          >
            {sendTestAlert.isPending && <Spinner className="size-4" />}
            Send test alert
          </Button>

          {verifyResult?.ok === true && (
            <Alert>
              <AlertTitle>Pipeline verified</AlertTitle>
              <AlertDescription>
                Alert received and routed to {verifyResult.hostname}.
              </AlertDescription>
            </Alert>
          )}
          {verifyResult?.ok === false && (
            <Alert variant="destructive">
              <AlertTitle>Verification failed</AlertTitle>
              <AlertDescription>{verifyResult.error}</AlertDescription>
            </Alert>
          )}

          <WizardActions>
            <Button variant="outline" onClick={() => setStep(1)}>
              Back
            </Button>
            <Button
              variant="secondary"
              onClick={() => void navigate({ to: "/fleet" })}
            >
              Done
            </Button>
          </WizardActions>
        </div>
      )}

      <ConfirmDialog
        open={blocker.status === "blocked"}
        onOpenChange={(o) => {
          if (!o) cancelLeaveSetup();
        }}
        title="Leave setup?"
        description="The server token you generated will be revoked."
        confirmLabel="Leave setup"
        destructive
        onConfirm={confirmLeaveSetup}
      />
    </Page>
  );
}
