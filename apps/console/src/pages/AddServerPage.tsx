import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useBlocker, useNavigate } from "@tanstack/react-router";
import type { RunnerRecord } from "@nightwarden/shared";
import { serviceIdentityKey } from "@nightwarden/shared";
import { ServerCard } from "@/components/layout/ServerCard";
import { AlertCircle } from "lucide-react";

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
import { Page, PageHeader, PageTitle } from "@/components/layout/Page";
import {
  WizardStepper,
  WizardActions,
} from "@/components/layout/WizardStepper";
import { ConfirmDialog } from "@/components/layout/ConfirmDialog";
import { CopyableSnippet } from "@/components/layout/CopyableSnippet";
import { ICON_INLINE } from "@/lib/iconProps";
import { ApiError, apiFetch } from "@/api/client";

export type Provider = "docker" | "kubernetes";

interface MintedToken {
  id: string;
  token: string;
}

const RUNNER_POLL_MS = 3000;

const STEP_TITLES = [
  "Server details",
  "Install the runner",
  "Confirm what it sees",
];

export function AddServerPage(): React.JSX.Element {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [provider, setProvider] = useState<Provider | null>(null);
  const [serverName, setServerName] = useState("");
  const [minting, setMinting] = useState(false);
  const [mintedToken, setMintedToken] = useState<MintedToken | null>(null);
  const [installText, setInstallText] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [committed, setCommitted] = useState(false);

  const serverNameError = serverName.includes("/")
    ? "Server name must not contain '/'"
    : null;
  const canContinueFromServer = provider !== null && serverNameError === null;

  const { data: runners } = useQuery<RunnerRecord[]>({
    queryKey: ["wizard-runners"],
    queryFn: () => apiFetch<RunnerRecord[]>("/api/runners"),
    enabled: step === 1 && mintedToken !== null,
    refetchInterval: step === 1 ? RUNNER_POLL_MS : false,
  });

  const connectedRunner = runners?.find(
    (r) => r.token === mintedToken?.id && r.online && r.hostname !== null,
  );

  // Read from the manifest the runner already sent: nothing is dispatched, so
  // checking the wiring cannot start an investigation or spend a token.
  const advertised = (
    connectedRunner?.manifest?.capabilities.services ?? []
  ).map((entry) => serviceIdentityKey(entry.identity));

  // Snippets live only on the Alertmanager page (one owner); the wizard just
  // points there the moment routing ambiguity becomes possible.
  const connectedDockerServers = (runners ?? []).filter(
    (r) =>
      r.online &&
      r.hostname !== null &&
      r.manifest?.capabilities.docker === true,
  ).length;

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
      const res = await fetch(installUrl, {
        headers: { Authorization: `Bearer ${minted.token}` },
      });
      if (!res.ok) throw new Error(`${installUrl} ${res.status}`);
      setInstallText(await res.text());
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

  return (
    <Page>
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
            <FieldLabel htmlFor="server-name">
              Server name (optional)
            </FieldLabel>
            <FieldDescription>
              Only needed to tell the same service apart across several servers.
              Naming one means your alerts must carry that name too, and the
              Alertmanager page hands you the snippet for it.
            </FieldDescription>
            <Input
              id="server-name"
              placeholder="e.g. prod-web-01"
              value={serverName}
              aria-invalid={serverNameError !== null}
              onChange={(e) => setServerName(e.currentTarget.value)}
            />
            {serverNameError && (
              <FieldError>
                <AlertCircle {...ICON_INLINE} />
                {serverNameError}
              </FieldError>
            )}
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
            What this server advertises. An alert reaches a service by carrying
            labels that produce one of these keys.
          </p>

          {advertised.length === 0 && (
            <Alert variant="warning">
              <AlertTitle>No services detected</AlertTitle>
              <AlertDescription>
                The runner connected but sees no containers or workloads. On
                Docker that usually means the socket is not mounted.
              </AlertDescription>
            </Alert>
          )}

          {connectedRunner && <ServerCard runner={connectedRunner} />}

          {connectedDockerServers >= 2 && (
            <p className="text-sm text-muted-foreground">
              You now have {connectedDockerServers} servers - finish alert
              routing on the{" "}
              <Link to="/integrations/alertmanager" className="underline">
                Alertmanager page
              </Link>
              .
            </p>
          )}

          <WizardActions>
            <Button variant="outline" onClick={() => setStep(1)}>
              Back
            </Button>
            <Button
              variant="secondary"
              onClick={() => void navigate({ to: "/integrations/runner" })}
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
