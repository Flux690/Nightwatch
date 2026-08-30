import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useBlocker, useNavigate } from "@tanstack/react-router";
import type { Platform, RunnerRecord } from "@nightwarden/shared";
import { serverNameError } from "@nightwarden/shared";
import { ServerCard } from "@/features/integrations/runners/ServerCard";
import { AlertCircle } from "lucide-react";

import { Alert, AlertTitle, AlertDescription } from "@/shared/ui/alert";
import { StatusText } from "@/shared/ui/status";
import { Button } from "@/shared/ui/button";
import {
  Field,
  FieldLabel,
  FieldDescription,
  FieldError,
} from "@/shared/ui/field";
import { Input } from "@/shared/ui/input";
import { Spinner } from "@/shared/ui/spinner";
import { Page } from "@/shared/ui/Page";
import {
  WizardStepper,
  WizardActions,
} from "@/features/integrations/runners/WizardStepper";
import { ConfirmDialog } from "@/shared/ui/ConfirmDialog";
import { CopyableSnippet } from "@/shared/ui/CopyableSnippet";
import { ICON_INLINE } from "@/shared/lib/iconProps";
import { ApiError, apiFetch } from "@/shared/api/client";
import { PLATFORM_COPY } from "./RunnerListPage.js";

interface MintedToken {
  id: string;
  token: string;
}

const RUNNER_POLL_MS = 3000;

// One endpoint for both: the platform was stored when the token was minted, so
// the artifact that comes back is the one this runner's row already names.
const INSTALL_URL = "/api/runners/install";

export function AddRunnerPage({
  platform,
}: {
  platform: Platform;
}): React.JSX.Element {
  const navigate = useNavigate();
  const copy = PLATFORM_COPY[platform];
  const listPath = `/integrations/${platform}`;

  const [step, setStep] = useState(0);
  const [serverName, setServerName] = useState("");
  const [minting, setMinting] = useState(false);
  const [mintedToken, setMintedToken] = useState<MintedToken | null>(null);
  const [installText, setInstallText] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [committed, setCommitted] = useState(false);
  const [touched, setTouched] = useState(false);

  const STEP_TITLES = ["Name it", "Install the runner", "Confirm what it sees"];

  // The same rule the mint route enforces, so a name that passes here cannot
  // come back a 400. Shown once typing starts: an untouched field is not a
  // mistake, but Continue stays shut from the moment the page loads.
  const nameError = serverNameError(serverName);
  const shownError = touched ? nameError : null;

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
  const advertised = (connectedRunner?.manifest?.services ?? []).map(
    (entry) => entry.target,
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
    if (nameError !== null) return;
    setStep(1);
    setMinting(true);
    setInstallError(null);
    try {
      const minted = await apiFetch<MintedToken>("/api/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform: platform,
          serverName: serverName.trim(),
        }),
      });
      setMintedToken(minted);

      const res = await fetch(INSTALL_URL, {
        headers: { Authorization: `Bearer ${minted.token}` },
      });
      if (!res.ok) throw new Error(`${INSTALL_URL} ${res.status}`);
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
    <Page
      measure="form"
      crumbs={[
        { label: "Integrations", to: "/integrations" },
        { label: copy.plural, to: listPath },
        { label: `Add a ${copy.singular.toLowerCase()}` },
      ]}
    >
      <WizardStepper step={step} total={3} title={STEP_TITLES[step]} />

      {step === 0 && (
        <div className="flex flex-col gap-8">
          <Field>
            <FieldLabel htmlFor="server-name">Server name</FieldLabel>
            <FieldDescription>
              The name NightWarden addresses this {copy.singular.toLowerCase()}{" "}
              by, and the first part of every service address. Must be unique.
            </FieldDescription>
            <Input
              measure="short"
              id="server-name"
              placeholder={
                platform === "docker" ? "e.g. prod-web-01" : "e.g. prod-cluster"
              }
              value={serverName}
              aria-invalid={shownError !== null}
              onChange={(e) => {
                setTouched(true);
                setServerName(e.currentTarget.value);
              }}
            />
            {/* Always present: a row that appears on error shifts the form. */}
            <div className="min-h-5">
              {shownError && (
                <FieldError>
                  <AlertCircle {...ICON_INLINE} />
                  {shownError}
                </FieldError>
              )}
            </div>
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
              disabled={nameError !== null}
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
                  {platform === "docker"
                    ? "Run this on the host to install the runner:"
                    : "Apply this to the cluster to install the runner:"}
                </p>
                <CopyableSnippet
                  text={installText}
                  label="Copy install command"
                />
              </div>

              <div className="flex items-center gap-2">
                {connectedRunner ? (
                  <StatusText tone="ok">Runner connected</StatusText>
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
            What this runner advertises. An alert reaches a service by carrying
            labels that match one of these keys.
          </p>

          {advertised.length === 0 && (
            <Alert variant="warning">
              <AlertTitle>No services detected</AlertTitle>
              <AlertDescription>{copy.emptyHint}</AlertDescription>
            </Alert>
          )}

          {connectedRunner && <ServerCard runner={connectedRunner} />}

          <WizardActions>
            <Button variant="outline" onClick={() => setStep(1)}>
              Back
            </Button>
            <Button
              variant="secondary"
              onClick={() => void navigate({ to: listPath })}
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
        description="The runner token you generated will be revoked."
        confirmLabel="Leave setup"
        destructive
        onConfirm={confirmLeaveSetup}
      />
    </Page>
  );
}
