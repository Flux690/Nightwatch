import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useBlocker, useNavigate } from "@tanstack/react-router";
import type { RunnerRecord } from "@nightwarden/shared";
import { serviceIdentityKey } from "@nightwarden/shared";
import { ServerCard } from "@/components/layout/ServerCard";
import { AlertCircle, ArrowLeft } from "lucide-react";

import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { StatusText } from "@/components/ui/status";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldLabel,
  FieldDescription,
  FieldError,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
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
import { SUBSTRATE_COPY, type Substrate } from "./RunnerListPage.js";

interface MintedToken {
  id: string;
  token: string;
}

const RUNNER_POLL_MS = 3000;

// One endpoint for both: the platform was stored when the token was minted, so
// the artifact that comes back is the one this runner's row already names.
const INSTALL_URL = "/api/runners/install";

export function AddRunnerPage({
  substrate,
}: {
  substrate: Substrate;
}): React.JSX.Element {
  const navigate = useNavigate();
  const copy = SUBSTRATE_COPY[substrate];
  const listPath = `/integrations/${substrate}`;

  const [step, setStep] = useState(0);
  const [displayName, setDisplayName] = useState("");
  const [minting, setMinting] = useState(false);
  const [mintedToken, setMintedToken] = useState<MintedToken | null>(null);
  const [installText, setInstallText] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [committed, setCommitted] = useState(false);

  const STEP_TITLES = ["Name it", "Install the runner", "Confirm what it sees"];

  const nameError = displayName.includes("/")
    ? "Display name must not contain '/'"
    : null;

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
          platform: substrate,
          serverName: displayName.trim(),
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
    <Page>
      {/* The wizard is reachable directly from an empty fleet, so browser back
          may leave the console entirely. This always returns to the list. */}
      <Link
        to={listPath}
        className="mb-2 inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft {...ICON_INLINE} />
        {copy.plural}
      </Link>
      <PageHeader>
        <PageTitle>Add a {copy.singular.toLowerCase()}</PageTitle>
      </PageHeader>

      <WizardStepper step={step} total={3} title={STEP_TITLES[step]} />

      {step === 0 && (
        <div className="flex flex-col gap-8">
          <Field className="max-w-120">
            <FieldLabel htmlFor="display-name">
              Display name (optional)
            </FieldLabel>
            <FieldDescription>
              Only tells connected runners apart, in the console and when the
              agent addresses one directly. It affects nothing else: services
              are identified by what your infrastructure already publishes.
            </FieldDescription>
            <Input
              id="display-name"
              placeholder={
                substrate === "docker"
                  ? "e.g. prod-web-01"
                  : "e.g. prod-cluster"
              }
              value={displayName}
              aria-invalid={nameError !== null}
              onChange={(e) => setDisplayName(e.currentTarget.value)}
            />
            {nameError && (
              <FieldError>
                <AlertCircle {...ICON_INLINE} />
                {nameError}
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
                  {substrate === "docker"
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
