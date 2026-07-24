import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { CircleCheckIcon, ExternalLink, RefreshCw } from "lucide-react";
import type {
  GitHubErrorBody,
  GitHubIntegrationStatus,
  GitHubRepoPage,
  GitHubRepoSummary,
} from "@nightwarden/shared";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import { FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { ConfirmDialog } from "@/components/layout/ConfirmDialog";
import { Page, PageHeader, PageTitle } from "@/components/layout/Page";
import { expiryDaysFrom } from "@/hooks/useGitHubExpiryDays";
import { ICON_UI } from "@/lib/iconProps";
import { toast } from "@/lib/toast";
import { apiFetch } from "@/api/client";

/* Repo selection stays on GitHub's own picker, the user's deliberate consent
   moment; no `issues` permission since NightWarden opens PRs, not issues. */
const FINE_GRAINED_TOKEN_URL =
  "https://github.com/settings/personal-access-tokens/new" +
  "?name=NightWarden" +
  "&description=NightWarden%20proposes%20fixes%20as%20draft%20pull%20requests" +
  "&expires_in=90&contents=write&pull_requests=write";

/* Escape hatch for orgs that block fine-grained PATs entirely. */
const CLASSIC_TOKEN_URL =
  "https://github.com/settings/tokens/new?scopes=repo&description=NightWarden";

class GitHubRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: Partial<GitHubErrorBody>,
  ) {
    super(message);
    this.name = "GitHubRequestError";
  }
}

/* Shared request helper instead of apiFetch: the error ladder needs the typed
   `code` / `orgApprovalUrl` body fields, which apiFetch discards. */
async function githubRequest<T>(
  method: "POST" | "PATCH",
  url: string,
  payload: unknown,
): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let body: Partial<GitHubErrorBody> = {};
    try {
      // Same trusted-cast policy as apiFetch: both ends of this contract are ours.
      body = (await res.json()) as Partial<GitHubErrorBody>;
    } catch {
      // Non-JSON error body; the status-based message below covers it.
    }
    throw new GitHubRequestError(
      res.status,
      typeof body.error === "string"
        ? body.error
        : `Request failed (${res.status})`,
      body,
    );
  }
  // See apiFetch: responses are shape-checked at compile time via @nightwarden/shared.
  return (await res.json()) as T;
}

function githubPost<T>(url: string, payload: unknown): Promise<T> {
  return githubRequest<T>("POST", url, payload);
}

function githubPatch<T>(url: string, payload: unknown): Promise<T> {
  return githubRequest<T>("PATCH", url, payload);
}

interface LadderContent {
  title: string;
  detail: string;
  showRegenerate: boolean;
  orgApprovalUrl?: string;
}

/* The deterministic error ladder: one rendering per signal, honest about
   GitHub's deliberate 404 ambiguity. */
function ladderContent(err: unknown): LadderContent {
  if (err instanceof GitHubRequestError) {
    switch (err.body.code) {
      case "invalid_token":
        return {
          title: "Token invalid or expired",
          detail:
            "GitHub rejected the token. Regenerate it and paste the new one.",
          showRegenerate: true,
        };
      case "sso_required":
        return {
          title: "SSO authorization required",
          detail:
            "Authorize this token for your organization's SSO on GitHub, then try again.",
          showRegenerate: false,
        };
      case "repo_not_found":
        return {
          title: "Repository not reachable",
          detail:
            err.body.orgApprovalUrl !== undefined
              ? "The repository may have been renamed or deleted, access revoked - or the token may be waiting on organization approval."
              : "The repository may have been renamed or deleted, or the token's access revoked.",
          showRegenerate: false,
          ...(err.body.orgApprovalUrl !== undefined && {
            orgApprovalUrl: err.body.orgApprovalUrl,
          }),
        };
      default:
        return {
          title: "GitHub unreachable",
          detail: err.message,
          showRegenerate: false,
        };
    }
  }
  return {
    title: "Request failed",
    detail: err instanceof Error ? err.message : "Try again.",
    showRegenerate: false,
  };
}

function LadderAlert({ error }: { error: unknown }): React.JSX.Element {
  const content = ladderContent(error);
  return (
    <Alert variant="destructive">
      <AlertTitle>{content.title}</AlertTitle>
      <AlertDescription>
        <span>{content.detail}</span>
        <span className="flex gap-2">
          {content.showRegenerate && (
            <a
              href={FINE_GRAINED_TOKEN_URL}
              target="_blank"
              rel="noreferrer"
              className="font-medium underline underline-offset-4"
            >
              Regenerate token on GitHub
            </a>
          )}
          {content.orgApprovalUrl !== undefined && (
            <a
              href={content.orgApprovalUrl}
              target="_blank"
              rel="noreferrer"
              className="font-medium underline underline-offset-4"
            >
              Review pending token requests
            </a>
          )}
        </span>
      </AlertDescription>
    </Alert>
  );
}

export function GitHubConnectPage(): React.JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: status } = useQuery<GitHubIntegrationStatus>({
    queryKey: ["github-integration"],
    queryFn: () =>
      apiFetch<GitHubIntegrationStatus>("/api/integrations/github"),
  });
  const configured = status?.configured === true;

  const [token, setToken] = useState("");
  const [changingToken, setChangingToken] = useState(false);
  const [repos, setRepos] = useState<GitHubRepoSummary[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [validating, setValidating] = useState(false);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [preflightIssue, setPreflightIssue] = useState<string | null>(null);

  // Sandbox prerequisites (docker + git on the API host), checked the moment
  // the page opens: fail loud at setup time, never at 3am mid-incident.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await githubPost<{ ok: boolean; reason?: string }>(
          "/api/integrations/github/preflight",
          {},
        );
        if (!cancelled && !result.ok) {
          setPreflightIssue(
            result.reason ?? "Sandbox prerequisites are missing",
          );
        }
      } catch {
        // Advisory only - an unreachable preflight must not block onboarding.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const usingFreshToken = token.trim() !== "";
  const showTokenInput = changingToken || (!configured && repos === null);

  // Management mode always shows the live combobox, pre-selected to the
  // current binding - no extra click to "reveal" it once you're connected.
  useEffect(() => {
    if (configured && repos === null) {
      void loadReposForChange();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured]);

  function tokenSummaryText(): string {
    if (!usingFreshToken && configured) {
      const days = expiryDaysFrom(status);
      if (days !== null) {
        if (days <= 0) return "Validated - token expired";
        return `Validated - expires in ${String(days)} day${days === 1 ? "" : "s"}`;
      }
    }
    return "Validated";
  }

  function fetchRepos(pageNum: number): Promise<GitHubRepoPage> {
    const body = usingFreshToken ? { token, page: pageNum } : { page: pageNum };
    return githubPost<GitHubRepoPage>("/api/integrations/github/repos", body);
  }

  async function validate(): Promise<void> {
    setValidating(true);
    setError(null);
    try {
      const data = await fetchRepos(1);
      setRepos(data.repos);
      setHasMore(data.hasMore);
      setPage(1);
      setSelected(
        data.repos.length === 1 ? (data.repos[0]?.fullName ?? null) : null,
      );
      setChangingToken(false);
      toast.success("Token validated");
    } catch (err) {
      setError(err);
      setRepos(null);
    } finally {
      setValidating(false);
    }
  }

  // Rebinding to a different repo the token already grants needs no fresh
  // token - the repos endpoint falls back to the stored credential.
  async function loadReposForChange(): Promise<void> {
    setLoadingRepos(true);
    setError(null);
    try {
      const data = await fetchRepos(1);
      setRepos(data.repos);
      setHasMore(data.hasMore);
      setPage(1);
      const bound = status?.repo ?? null;
      setSelected(
        bound !== null && data.repos.some((r) => r.fullName === bound)
          ? bound
          : data.repos.length === 1
            ? (data.repos[0]?.fullName ?? null)
            : null,
      );
    } catch (err) {
      setError(err);
    } finally {
      setLoadingRepos(false);
    }
  }

  async function loadMore(): Promise<void> {
    setLoadingMore(true);
    try {
      const next = page + 1;
      const data = await fetchRepos(next);
      setRepos((prev) => [...(prev ?? []), ...data.repos]);
      setHasMore(data.hasMore);
      setPage(next);
    } catch (err) {
      setError(err);
    } finally {
      setLoadingMore(false);
    }
  }

  // Full (re)bind: the only path that ever sends a token, so it's the only
  // path that can replace the stored credential.
  async function connectWithToken(): Promise<void> {
    if (selected === null) return;
    setConnecting(true);
    setError(null);
    try {
      await githubPost<GitHubIntegrationStatus>("/api/integrations/github", {
        token,
        repo: selected,
      });
      toast.success(
        configured ? "GitHub repository updated" : "GitHub connected",
      );
      setToken("");
      setChangingToken(false);
      void queryClient.invalidateQueries({ queryKey: ["github-integration"] });
    } catch (err) {
      setError(err);
    } finally {
      setConnecting(false);
    }
  }

  // Repo-only rebind: never sends a token, so the stored credential is the
  // only one that can ever be used here.
  async function updateRepoOnly(): Promise<void> {
    if (selected === null) return;
    setConnecting(true);
    setError(null);
    try {
      await githubPatch<GitHubIntegrationStatus>("/api/integrations/github", {
        repo: selected,
      });
      toast.success("GitHub repository updated");
      void queryClient.invalidateQueries({ queryKey: ["github-integration"] });
    } catch (err) {
      setError(err);
    } finally {
      setConnecting(false);
    }
  }

  async function disconnect(): Promise<void> {
    setDisconnecting(true);
    try {
      await apiFetch<void>("/api/integrations/github", { method: "DELETE" });
      toast.success("GitHub disconnected");
      void queryClient.invalidateQueries({ queryKey: ["github-integration"] });
      setToken("");
      setChangingToken(false);
      setRepos(null);
      setSelected(null);
      setHasMore(false);
      setPage(1);
      void navigate({ to: "/integrations" });
    } catch (err) {
      toast.show({
        title: "Could not disconnect",
        message: err instanceof Error ? err.message : "Try again.",
        variant: "error",
      });
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <Page>
      <PageHeader>
        <PageTitle>Connect GitHub</PageTitle>
      </PageHeader>

      <div className="flex flex-col gap-6">
        <p className="max-w-3xl text-sm text-muted-foreground">
          Let investigations read the bound repository, verify a fix, and
          propose it as a draft pull request. NightWarden never merges.
        </p>
        {preflightIssue !== null && (
          <Alert variant="destructive">
            <AlertTitle>Code sandbox prerequisites missing</AlertTitle>
            <AlertDescription>
              {preflightIssue}. You can finish connecting, but code sessions
              will fail until this is fixed on the API host.
            </AlertDescription>
          </Alert>
        )}

        <div className="flex flex-col gap-2">
          <FieldLabel htmlFor="github-token" className="text-base">
            Personal access token
          </FieldLabel>
          <FieldDescription>
            Create a fine-grained token on GitHub, choose which repository to
            grant access to, then paste it below.
            <br />
            If your organization blocks fine-grained tokens, create a{" "}
            <a href={CLASSIC_TOKEN_URL} target="_blank" rel="noreferrer">
              classic token
            </a>{" "}
            with repo scope instead.
          </FieldDescription>
          {showTokenInput ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  render={
                    <a
                      href={FINE_GRAINED_TOKEN_URL}
                      target="_blank"
                      rel="noreferrer"
                    />
                  }
                >
                  <ExternalLink {...ICON_UI} />
                  Create token on GitHub
                </Button>
              </div>
              <div className="flex gap-2">
                <Input
                  id="github-token"
                  type="password"
                  placeholder="Paste token"
                  autoComplete="off"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  className="max-w-90"
                />
                <Button
                  size="sm"
                  disabled={token.trim() === "" || validating}
                  onClick={() => void validate()}
                >
                  {validating && <Spinner className="size-3" />}
                  Validate
                </Button>
              </div>
            </>
          ) : (
            <div className="flex items-center gap-2 text-sm">
              <CircleCheckIcon {...ICON_UI} className="text-success" />
              <span>{tokenSummaryText()}</span>
              <Button
                size="xs"
                variant="ghost"
                className="text-muted-foreground"
                onClick={() => setChangingToken(true)}
              >
                Change
              </Button>
            </div>
          )}
        </div>

        {error !== null && <LadderAlert error={error} />}

        {!showTokenInput && repos === null && configured && (
          <Spinner className="size-4" />
        )}

        {!showTokenInput &&
          repos !== null &&
          (repos.length === 0 ? (
            <FieldDescription>
              The token can reach no repositories. If you granted one on GitHub,
              an organization admin may still need to approve the token -
              refresh once that is done.
            </FieldDescription>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <FieldLabel>Choose the repository</FieldLabel>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Refresh repositories"
                  disabled={validating || loadingRepos}
                  onClick={() =>
                    void (usingFreshToken ? validate() : loadReposForChange())
                  }
                >
                  <RefreshCw {...ICON_UI} />
                </Button>
              </div>
              <Combobox
                items={repos.map((r) => r.fullName)}
                value={selected}
                onValueChange={(v) => setSelected(v)}
              >
                <ComboboxInput
                  aria-label="Repository"
                  placeholder="Search repositories"
                  className="w-180 self-start"
                />
                <ComboboxContent>
                  <ComboboxList>
                    <ComboboxEmpty>No repositories match.</ComboboxEmpty>
                    {repos.map((r) => (
                      <ComboboxItem key={r.fullName} value={r.fullName}>
                        <span className="min-w-0 truncate font-mono">
                          {r.fullName}
                        </span>
                        {r.private && (
                          <Badge variant="secondary">Private</Badge>
                        )}
                      </ComboboxItem>
                    ))}
                  </ComboboxList>
                </ComboboxContent>
              </Combobox>
              {hasMore && (
                <Button
                  size="xs"
                  variant="secondary"
                  className="self-start"
                  disabled={loadingMore}
                  onClick={() => void loadMore()}
                >
                  {loadingMore && <Spinner className="size-3" />}
                  Load more
                </Button>
              )}
              <FieldDescription>
                Don&apos;t see the repo you granted? If it belongs to an
                organization, an admin may need to approve your token first -
                refresh once that is done.
              </FieldDescription>
              <Button
                size="sm"
                className="self-start"
                disabled={
                  selected === null ||
                  connecting ||
                  (configured && !usingFreshToken && selected === status?.repo)
                }
                onClick={() =>
                  void (usingFreshToken ? connectWithToken() : updateRepoOnly())
                }
              >
                {connecting && <Spinner className="size-3" />}
                {configured ? "Update repository" : "Connect repository"}
              </Button>
            </div>
          ))}

        {configured && (
          <div>
            <Button
              size="sm"
              variant="outline"
              className="self-start text-destructive"
              disabled={disconnecting}
              onClick={() => setConfirmOpen(true)}
            >
              {disconnecting && <Spinner className="size-3" />}
              Disconnect
            </Button>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Disconnect GitHub?"
        description={`This deletes NightWarden's stored copy of the token and unbinds ${status?.repo ?? "the repository"}. The token itself stays valid until you revoke it on GitHub.`}
        confirmLabel="Disconnect"
        destructive
        onConfirm={() => void disconnect()}
      />
    </Page>
  );
}
