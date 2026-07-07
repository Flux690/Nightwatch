import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, RefreshCw } from "lucide-react";
import type {
  GitHubErrorBody,
  GitHubIntegrationStatus,
  GitHubRepoPage,
  GitHubRepoSummary,
} from "@nightwatch/shared";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { ConfirmDialog } from "@/components/layout/ConfirmDialog";
import { Page, PageHeader, PageTitle } from "@/components/layout/Page";
import { expiryDaysFrom } from "@/hooks/useGitHubExpiryDays";
import { ICON_UI } from "@/lib/iconProps";
import { toast } from "@/lib/toast";
import { apiFetch } from "@/api/client";
import { cn } from "@/lib/utils";

/* Pre-filled fine-grained PAT mint page. Repository selection happens on
   GitHub's own page ("Only select repositories") - that native picker is the
   user's deliberate consent moment and cannot be pre-filled by design.
   No `issues` permission: Nightwatch opens PRs, not issues. */
const FINE_GRAINED_TOKEN_URL =
  "https://github.com/settings/personal-access-tokens/new" +
  "?name=Nightwatch" +
  "&description=Nightwatch%20proposes%20fixes%20as%20draft%20pull%20requests" +
  "&expires_in=90&contents=write&pull_requests=write";

/* Escape hatch for orgs that block fine-grained PATs entirely. */
const CLASSIC_TOKEN_URL =
  "https://github.com/settings/tokens/new?scopes=repo&description=Nightwatch";

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

/* Local POST helper instead of apiFetch: the error ladder needs the typed
   `code` / `orgApprovalUrl` fields from the body, which apiFetch discards. */
async function githubPost<T>(url: string, payload: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
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
  // See apiFetch: responses are shape-checked at compile time via @nightwatch/shared.
  return (await res.json()) as T;
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

function GitHubConnectFlow({
  onConnected,
  onCancel,
}: {
  onConnected: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [token, setToken] = useState("");
  const [showClassic, setShowClassic] = useState(false);
  const [repos, setRepos] = useState<GitHubRepoSummary[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [validating, setValidating] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const filtered = useMemo(() => {
    if (repos === null) return [];
    const q = search.trim().toLowerCase();
    if (q === "") return repos;
    return repos.filter((r) => r.fullName.toLowerCase().includes(q));
  }, [repos, search]);

  async function validate(): Promise<void> {
    setValidating(true);
    setError(null);
    try {
      const data = await githubPost<GitHubRepoPage>(
        "/api/integrations/github/repos",
        { token, page: 1 },
      );
      setRepos(data.repos);
      setHasMore(data.hasMore);
      setPage(1);
      setSelected(
        data.repos.length === 1 ? (data.repos[0]?.fullName ?? null) : null,
      );
    } catch (err) {
      setError(err);
      setRepos(null);
    } finally {
      setValidating(false);
    }
  }

  async function loadMore(): Promise<void> {
    setLoadingMore(true);
    try {
      const next = page + 1;
      const data = await githubPost<GitHubRepoPage>(
        "/api/integrations/github/repos",
        { token, page: next },
      );
      setRepos((prev) => [...(prev ?? []), ...data.repos]);
      setHasMore(data.hasMore);
      setPage(next);
    } catch (err) {
      setError(err);
    } finally {
      setLoadingMore(false);
    }
  }

  async function connect(): Promise<void> {
    if (selected === null) return;
    setConnecting(true);
    setError(null);
    try {
      await githubPost<GitHubIntegrationStatus>("/api/integrations/github", {
        token,
        repo: selected,
      });
      toast.success("GitHub connected");
      onConnected();
    } catch (err) {
      setError(err);
    } finally {
      setConnecting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <FieldLabel htmlFor="github-token">Personal access token</FieldLabel>
        <FieldDescription>
          Create a fine-grained token on GitHub - pick the repository there
          under &ldquo;Only select repositories&rdquo; - then paste it here.
          Nightwatch lists exactly the repositories you granted.
        </FieldDescription>
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
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground"
            onClick={() => setShowClassic((v) => !v)}
          >
            Advanced
          </Button>
        </div>
        {showClassic && (
          <FieldDescription>
            Organization blocks fine-grained tokens?{" "}
            <a href={CLASSIC_TOKEN_URL} target="_blank" rel="noreferrer">
              Create a classic token
            </a>{" "}
            with repo scope instead - the picker below then lists everything the
            token can reach.
          </FieldDescription>
        )}
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
      </div>

      {error !== null && <LadderAlert error={error} />}

      {repos !== null && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <FieldLabel>Choose the repository</FieldLabel>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Refresh repositories"
              disabled={validating}
              onClick={() => void validate()}
            >
              <RefreshCw {...ICON_UI} />
            </Button>
          </div>
          {repos.length > 5 && (
            <Input
              aria-label="Search repositories"
              placeholder="Search repositories"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="max-w-90"
            />
          )}
          {repos.length === 0 ? (
            <FieldDescription>
              The token can reach no repositories. If you granted one on GitHub,
              an organization admin may still need to approve the token -
              refresh once that is done.
            </FieldDescription>
          ) : (
            <>
              <RadioGroup
                aria-label="Repository"
                value={selected ?? ""}
                onValueChange={(v) => setSelected(String(v))}
              >
                {filtered.map((r) => (
                  <label
                    key={r.fullName}
                    htmlFor={`repo-${r.fullName}`}
                    className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-sm has-data-checked:border-primary"
                  >
                    <RadioGroupItem
                      value={r.fullName}
                      id={`repo-${r.fullName}`}
                    />
                    <span className="min-w-0 truncate font-mono">
                      {r.fullName}
                    </span>
                    {r.private && <Badge variant="secondary">Private</Badge>}
                  </label>
                ))}
              </RadioGroup>
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
            </>
          )}
        </div>
      )}

      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={selected === null || connecting}
          onClick={() => void connect()}
        >
          {connecting && <Spinner className="size-3" />}
          Connect repository
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function GitHubStatusBlock({
  status,
  onDisconnected,
}: {
  status: GitHubIntegrationStatus;
  onDisconnected: () => void;
}): React.JSX.Element {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const days = expiryDaysFrom(status);
  const expiring = days !== null && days <= 7;

  async function disconnect(): Promise<void> {
    setDisconnecting(true);
    try {
      await apiFetch<void>("/api/integrations/github", { method: "DELETE" });
      toast.success("GitHub disconnected");
      onDisconnected();
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
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Repository</dt>
        <dd className="m-0">
          <a
            href={`https://github.com/${status.repo ?? ""}`}
            target="_blank"
            rel="noreferrer"
            className="font-mono no-underline hover:underline"
          >
            {status.repo}
          </a>
        </dd>
        <dt className="text-muted-foreground">Token expires</dt>
        <dd className={cn("m-0", expiring && "font-medium text-warning")}>
          {status.expiresAt === null
            ? "No expiry recorded"
            : days !== null && days <= 0
              ? "Expired"
              : `${new Date(status.expiresAt).toLocaleDateString()} (${String(days)} days)`}
        </dd>
        <dt className="text-muted-foreground">Validated</dt>
        <dd className="m-0">
          {status.validatedAt === null
            ? "-"
            : new Date(status.validatedAt).toLocaleString()}
        </dd>
      </dl>
      {expiring && (
        <Alert>
          <AlertTitle>
            {days !== null && days <= 0
              ? "Token expired"
              : `Token expires in ${String(days)} days`}
          </AlertTitle>
          <AlertDescription>
            <span>
              Generate a replacement on GitHub, then reconnect with the new
              token.
            </span>
            <a
              href={FINE_GRAINED_TOKEN_URL}
              target="_blank"
              rel="noreferrer"
              className="font-medium underline underline-offset-4"
            >
              Regenerate token on GitHub
            </a>
          </AlertDescription>
        </Alert>
      )}
      <div>
        <Button
          size="sm"
          variant="outline"
          className="text-destructive"
          disabled={disconnecting}
          onClick={() => setConfirmOpen(true)}
        >
          {disconnecting && <Spinner className="size-3" />}
          Disconnect
        </Button>
      </div>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Disconnect GitHub?"
        description={`This deletes Nightwatch's stored copy of the token and unbinds ${status.repo ?? "the repository"}. The token itself stays valid until you revoke it on GitHub.`}
        confirmLabel="Disconnect"
        destructive
        onConfirm={() => void disconnect()}
      />
    </div>
  );
}

export function IntegrationsPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [connectOpen, setConnectOpen] = useState(false);

  const { data: status, isLoading } = useQuery<GitHubIntegrationStatus>({
    queryKey: ["github-integration"],
    queryFn: () =>
      apiFetch<GitHubIntegrationStatus>("/api/integrations/github"),
  });

  const days = expiryDaysFrom(status);
  const expiring = days !== null && days <= 7;

  function refresh(): void {
    setConnectOpen(false);
    void queryClient.invalidateQueries({ queryKey: ["github-integration"] });
  }

  return (
    <Page>
      <PageHeader>
        <PageTitle>Integrations</PageTitle>
      </PageHeader>
      <Card className={cn(expiring && "border-l-[3px] border-l-warning")}>
        <CardHeader>
          <CardTitle>GitHub</CardTitle>
          <CardDescription>
            Let investigations read the bound repository, verify a fix, and
            propose it as a draft pull request. Nightwatch never merges.
          </CardDescription>
          <CardAction>
            {status?.configured === true ? (
              <Badge variant="success" dot>
                Connected
              </Badge>
            ) : (
              !connectOpen && (
                <Button size="sm" onClick={() => setConnectOpen(true)}>
                  Connect GitHub
                </Button>
              )
            )}
          </CardAction>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Spinner className="size-4" />
          ) : status?.configured === true ? (
            <GitHubStatusBlock status={status} onDisconnected={refresh} />
          ) : connectOpen ? (
            <GitHubConnectFlow
              onConnected={refresh}
              onCancel={() => setConnectOpen(false)}
            />
          ) : (
            <p className="m-0 text-sm text-muted-foreground">
              Not connected. One repository is bound per integration; you pick
              it from the exact list your token grants.
            </p>
          )}
        </CardContent>
      </Card>
    </Page>
  );
}
