import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheckIcon, ExternalLink, RefreshCw } from "lucide-react";
import type {
  GitHubErrorBody,
  GitHubIntegrationStatus,
  GitHubRepoPage,
  GitHubRepoSummary,
} from "@nightwarden/shared";

import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/alert";
import { MetaText } from "@/shared/ui/status";
import { Button } from "@/shared/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/shared/ui/combobox";
import { Field, FieldDescription, FieldLabel } from "@/shared/ui/field";
import { Input } from "@/shared/ui/input";
import { Spinner } from "@/shared/ui/spinner";
import { ConfirmDialog } from "@/shared/ui/ConfirmDialog";
import { Page } from "@/shared/ui/Page";
import { expiryDaysFrom } from "@/features/integrations/github/useGitHubExpiryDays";
import { ICON_UI } from "@/shared/lib/iconProps";
import { toast } from "@/shared/lib/toast";
import { ApiError, apiFetch } from "@/shared/api/client";
import { INTEGRATION_CATALOG } from "../catalog";
import { IntegrationHeader } from "@/features/integrations/IntegrationHeader";
import { useDisconnect } from "../useIntegration";

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

/* Both ends of this contract are ours: the route answers with GitHubErrorBody,
   which is what the ladder below branches on. */
function errorBody(err: unknown): Partial<GitHubErrorBody> {
  if (!(err instanceof ApiError)) return {};
  if (typeof err.body !== "object" || err.body === null) return {};
  return err.body as Partial<GitHubErrorBody>;
}

const githubPost = <T,>(url: string, payload: unknown): Promise<T> =>
  apiFetch<T>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

const githubPatch = <T,>(url: string, payload: unknown): Promise<T> =>
  apiFetch<T>(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

interface LadderContent {
  title: string;
  detail: string;
  showRegenerate: boolean;
  orgApprovalUrl?: string;
}

/* The deterministic error ladder: one rendering per signal, honest about
   GitHub's deliberate 404 ambiguity. */
function ladderContent(err: unknown): LadderContent {
  const body = errorBody(err);
  if (err instanceof ApiError) {
    switch (body.code) {
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
            body.orgApprovalUrl !== undefined
              ? "The repository may have been renamed or deleted, access revoked - or the token may be waiting on organization approval."
              : "The repository may have been renamed or deleted, or the token's access revoked.",
          showRegenerate: false,
          ...(body.orgApprovalUrl !== undefined && {
            orgApprovalUrl: body.orgApprovalUrl,
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

/* Advisory, not a gate: the sandbox is what a code session needs, and a host
   missing it can still finish connecting and fix the host afterwards. */
function PreflightWarning({ issue }: { issue: string }): React.JSX.Element {
  return (
    <Alert variant="destructive">
      <AlertTitle>Code sandbox prerequisites missing</AlertTitle>
      <AlertDescription>
        {issue}. You can finish connecting, but code sessions will fail until
        this is fixed on the API host.
      </AlertDescription>
    </Alert>
  );
}

/* The picker and the words about it. Refresh sits beside the label rather than
   under the list, because the reason to press it - an admin has just approved
   the token - is the reason the list is wrong. */
function RepoCombobox({
  repos,
  selected,
  onSelect,
  refreshing,
  onRefresh,
}: {
  repos: GitHubRepoSummary[];
  selected: string | null;
  onSelect: (value: string | null) => void;
  refreshing: boolean;
  onRefresh: () => void;
}): React.JSX.Element {
  return (
    <Field>
      <div className="flex items-center gap-2">
        <FieldLabel htmlFor="github-repo">Choose the repository</FieldLabel>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Refresh repositories"
          disabled={refreshing}
          onClick={onRefresh}
        >
          <RefreshCw {...ICON_UI} />
        </Button>
      </div>
      <Combobox
        items={repos.map((r) => r.fullName)}
        value={selected}
        onValueChange={onSelect}
      >
        <ComboboxInput
          id="github-repo"
          placeholder="Search repositories"
          className="w-full"
        />
        <ComboboxContent>
          <ComboboxList>
            <ComboboxEmpty>No repositories match.</ComboboxEmpty>
            {repos.map((r) => (
              <ComboboxItem key={r.fullName} value={r.fullName}>
                <span className="min-w-0 truncate font-mono">{r.fullName}</span>
                {r.private && <MetaText>Private</MetaText>}
              </ComboboxItem>
            ))}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
      <FieldDescription>
        A repository owned by an organization appears only once an admin has
        approved the token. Refresh once that is done.
      </FieldDescription>
    </Field>
  );
}

export function GitHubConnectPage(): React.JSX.Element {
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
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Advisory only, and asked once: it is a POST, so the default would repeat
  // it on every window focus, and an unreachable preflight must not block setup.
  const preflight = useQuery({
    queryKey: ["github-preflight"],
    queryFn: () =>
      githubPost<{ ok: boolean; reason?: string }>(
        "/api/integrations/github/preflight",
        {},
      ),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const preflightIssue =
    preflight.data !== undefined && !preflight.data.ok
      ? (preflight.data.reason ?? "Sandbox prerequisites are missing")
      : null;

  const usingFreshToken = token.trim() !== "";
  const showTokenInput = changingToken || (!configured && repos === null);

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

  function takeFirstPage(data: GitHubRepoPage): void {
    setRepos(data.repos);
    setHasMore(data.hasMore);
    setPage(1);
  }

  const validate = useMutation({
    mutationFn: () => fetchRepos(1),
    onMutate: () => setError(null),
    onSuccess: (data) => {
      takeFirstPage(data);
      setSelected(
        data.repos.length === 1 ? (data.repos[0]?.fullName ?? null) : null,
      );
      setChangingToken(false);
      toast.success("Token validated");
    },
    onError: (err) => {
      setError(err);
      setRepos(null);
    },
  });

  /* Rebinding to a different repo the token already grants needs no fresh
     token - the repos endpoint falls back to the stored credential. */
  const loadRepos = useMutation({
    mutationFn: () => fetchRepos(1),
    onMutate: () => setError(null),
    onSuccess: (data) => {
      takeFirstPage(data);
      const bound = status?.repo ?? null;
      setSelected(
        bound !== null && data.repos.some((r) => r.fullName === bound)
          ? bound
          : data.repos.length === 1
            ? (data.repos[0]?.fullName ?? null)
            : null,
      );
    },
    onError: (err) => setError(err),
  });

  const loadMore = useMutation({
    mutationFn: () => fetchRepos(page + 1),
    onSuccess: (data) => {
      setRepos((prev) => [...(prev ?? []), ...data.repos]);
      setHasMore(data.hasMore);
      setPage((prev) => prev + 1);
    },
    onError: (err) => setError(err),
  });

  /* Full (re)bind: the only path that ever sends a token, so the only one that
     can replace the stored credential. */
  const connectWithToken = useMutation({
    mutationFn: (repo: string) =>
      githubPost<GitHubIntegrationStatus>("/api/integrations/github", {
        token,
        repo,
      }),
    onMutate: () => setError(null),
    onSuccess: async () => {
      toast.success(
        configured ? "GitHub repository updated" : "GitHub connected",
      );
      setToken("");
      setChangingToken(false);
      await queryClient.invalidateQueries({ queryKey: ["github-integration"] });
    },
    onError: (err) => setError(err),
  });

  /* Repo-only rebind: never sends a token, so the stored credential is the only
     one that can be used here. */
  const updateRepoOnly = useMutation({
    mutationFn: (repo: string) =>
      githubPatch<GitHubIntegrationStatus>("/api/integrations/github", {
        repo,
      }),
    onMutate: () => setError(null),
    onSuccess: async () => {
      toast.success("GitHub repository updated");
      await queryClient.invalidateQueries({ queryKey: ["github-integration"] });
    },
    onError: (err) => setError(err),
  });

  const disconnect = useDisconnect({
    label: "GitHub",
    queryKey: ["github-integration"],
    endpoint: () => "/api/integrations/github",
  });

  // Never while a typed token is in the box: reloading from the stored
  // credential would wipe the validation error the user still has to read.
  const runLoadRepos = loadRepos.mutate;
  useEffect(() => {
    if (configured && repos === null && !usingFreshToken) runLoadRepos();
  }, [configured, repos, usingFreshToken, runLoadRepos]);

  const validating = validate.isPending;
  const loadingRepos = loadRepos.isPending;
  const loadingMore = loadMore.isPending;
  const connecting = connectWithToken.isPending || updateRepoOnly.isPending;
  const disconnecting = disconnect.isPending;

  return (
    <Page
      measure="form"
      crumbs={[
        { label: "Integrations", to: "/integrations" },
        { label: "Connect GitHub" },
      ]}
    >
      <div className="flex flex-col gap-6">
        <IntegrationHeader identity={INTEGRATION_CATALOG.github} />
        {preflightIssue !== null && <PreflightWarning issue={preflightIssue} />}

        <Field>
          <FieldLabel htmlFor="github-token">Personal access token</FieldLabel>
          <FieldDescription>
            Create a fine-grained token, grant it the one repository, and paste
            it here.
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
                />
                <Button
                  disabled={token.trim() === "" || validating}
                  onClick={() => validate.mutate()}
                >
                  {validating && <Spinner className="size-4" />}
                  Validate
                </Button>
              </div>
            </>
          ) : (
            <div className="flex items-center gap-2 text-sm">
              <CircleCheckIcon {...ICON_UI} className="text-success" />
              <span>{tokenSummaryText()}</span>
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground"
                onClick={() => setChangingToken(true)}
              >
                Change
              </Button>
            </div>
          )}
        </Field>

        {error !== null && <LadderAlert error={error} />}

        {!showTokenInput && repos === null && configured && (
          <Spinner className="size-4" />
        )}

        {!showTokenInput &&
          repos !== null &&
          (repos.length === 0 ? (
            <FieldDescription>
              The token can reach no repositories. If you granted one owned by
              an organization, an admin has to approve the token first.
            </FieldDescription>
          ) : (
            /* The Field holds the control and the words about it. The two
               buttons are actions on the page, and a Field stretches
               whatever it holds to the width of the column. */
            <div className="flex flex-col gap-4">
              <RepoCombobox
                repos={repos}
                selected={selected}
                onSelect={setSelected}
                refreshing={validating || loadingRepos}
                onRefresh={() => {
                  if (usingFreshToken) validate.mutate();
                  else loadRepos.mutate();
                }}
              />
              {hasMore && (
                <Button
                  size="sm"
                  variant="secondary"
                  className="self-start"
                  disabled={loadingMore}
                  onClick={() => loadMore.mutate()}
                >
                  {loadingMore && <Spinner className="size-4" />}
                  Load more
                </Button>
              )}
              <Button
                className="self-start"
                disabled={
                  selected === null ||
                  connecting ||
                  (configured && !usingFreshToken && selected === status?.repo)
                }
                onClick={() => {
                  if (selected === null) return;
                  if (usingFreshToken) connectWithToken.mutate(selected);
                  else updateRepoOnly.mutate(selected);
                }}
              >
                {connecting && <Spinner className="size-4" />}
                {configured ? "Update repository" : "Connect repository"}
              </Button>
            </div>
          ))}

        {configured && (
          <div>
            <Button
              size="sm"
              variant="secondary"
              className="self-start"
              disabled={disconnecting}
              onClick={() => setConfirmOpen(true)}
            >
              {disconnecting && <Spinner className="size-4" />}
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
        onConfirm={() => disconnect.mutate()}
      />
    </Page>
  );
}
