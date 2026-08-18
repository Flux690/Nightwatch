import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { TriangleAlert } from "lucide-react";
import type {
  MetricsBackendKind,
  MetricsBackendStatus,
  MetricsEndpointInput,
} from "@nightwarden/shared";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { MetaText, StatusText } from "@/components/ui/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel, FieldDescription } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Page } from "@/components/layout/Page";
import { ConfirmDialog } from "@/components/layout/ConfirmDialog";
import { ICON_UI } from "@/lib/iconProps";
import { toast } from "@/lib/toast";
import { ApiError, apiFetch } from "@/api/client";
import { METRICS_BACKEND_CONTENT } from "./metricsBackendContent";
import { INTEGRATION_CATALOG } from "./integrationCatalog";
import { IntegrationHeader } from "@/components/layout/IntegrationHeader";

interface EndpointDraft {
  url: string;
  authHeader: string;
  basicUsername: string;
  basicPassword: string;
  orgId: string;
}

const EMPTY: EndpointDraft = {
  url: "",
  authHeader: "",
  basicUsername: "",
  basicPassword: "",
  orgId: "",
};

// Only what the user filled in travels: an empty field is not a credential.
function toInput(draft: EndpointDraft): MetricsEndpointInput {
  return {
    url: draft.url.trim(),
    ...(draft.authHeader.trim() && { authHeader: draft.authHeader.trim() }),
    ...(draft.basicUsername.trim() && {
      basicUsername: draft.basicUsername.trim(),
    }),
    ...(draft.basicPassword.trim() && {
      basicPassword: draft.basicPassword.trim(),
    }),
    ...(draft.orgId.trim() && { orgId: draft.orgId.trim() }),
  };
}

function EndpointFields({
  idPrefix,
  draft,
  onChange,
  authHelp,
}: {
  idPrefix: string;
  draft: EndpointDraft;
  onChange: (next: EndpointDraft) => void;
  authHelp: string;
}): React.JSX.Element {
  return (
    <>
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-auth`}>
          Authorization header (optional)
        </FieldLabel>
        <FieldDescription>{authHelp}</FieldDescription>
        <Input
          className="max-w-control"
          id={`${idPrefix}-auth`}
          type="password"
          placeholder="Bearer ..."
          value={draft.authHeader}
          onChange={(e) =>
            onChange({ ...draft, authHeader: e.currentTarget.value })
          }
        />
      </Field>
      <div className="flex max-w-control gap-3">
        <Field className="flex-1">
          <FieldLabel htmlFor={`${idPrefix}-user`}>
            Username (optional)
          </FieldLabel>
          <Input
            className="max-w-control"
            id={`${idPrefix}-user`}
            value={draft.basicUsername}
            onChange={(e) =>
              onChange({ ...draft, basicUsername: e.currentTarget.value })
            }
          />
        </Field>
        <Field className="flex-1">
          <FieldLabel htmlFor={`${idPrefix}-pass`}>
            Password (optional)
          </FieldLabel>
          <Input
            className="max-w-control"
            id={`${idPrefix}-pass`}
            type="password"
            value={draft.basicPassword}
            onChange={(e) =>
              onChange({ ...draft, basicPassword: e.currentTarget.value })
            }
          />
        </Field>
      </div>
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-org`}>Tenant (optional)</FieldLabel>
        <FieldDescription>
          Mimir requires a tenant when multi-tenancy is on.
        </FieldDescription>
        <Input
          className="max-w-control"
          id={`${idPrefix}-org`}
          value={draft.orgId}
          onChange={(e) => onChange({ ...draft, orgId: e.currentTarget.value })}
        />
      </Field>
    </>
  );
}

export function MetricsBackendPage({
  kind,
}: {
  kind: MetricsBackendKind;
}): React.JSX.Element {
  const content = METRICS_BACKEND_CONTENT[kind];
  const identity = INTEGRATION_CATALOG[kind];
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [query, setQuery] = useState<EndpointDraft>(EMPTY);
  const [rules, setRules] = useState<EndpointDraft>(EMPTY);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const { data: backends, isLoading } = useQuery<MetricsBackendStatus[]>({
    queryKey: ["metrics-backends"],
    queryFn: () =>
      apiFetch<MetricsBackendStatus[]>("/api/integrations/metrics"),
  });

  const mine = (backends ?? []).filter((b) => b.kind === kind);

  const connect = useMutation({
    mutationFn: () =>
      apiFetch<MetricsBackendStatus>("/api/integrations/metrics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          query: toInput(query),
          // Absent rather than empty: a backend with no rules endpoint is a
          // supported configuration, and the card says what it costs.
          ...(rules.url.trim() !== "" && { rules: toInput(rules) }),
        }),
      }),
    onMutate: () => setConnectError(null),
    onSuccess: async () => {
      setQuery(EMPTY);
      setRules(EMPTY);
      toast.success(`${identity.label} connected`);
      await queryClient.invalidateQueries({ queryKey: ["metrics-backends"] });
    },
    onError: (err) =>
      setConnectError(
        err instanceof ApiError ? err.message : "Could not reach the API",
      ),
  });

  const disconnect = useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/api/integrations/metrics/${id}`, { method: "DELETE" }),
    onSuccess: async () => {
      toast.success(`${identity.label} disconnected`);
      await queryClient.invalidateQueries({ queryKey: ["metrics-backends"] });
      void navigate({ to: "/integrations" });
    },
    onError: (err) =>
      toast.show({
        title: "Could not disconnect",
        message: err instanceof Error ? err.message : "Try again.",
        variant: "error",
      }),
  });

  return (
    <Page
      crumbs={[
        { label: "Integrations", to: "/integrations" },
        { label: identity.label },
      ]}
    >
      <div className="flex flex-col gap-8">
        <IntegrationHeader identity={identity} />

        {isLoading && (
          <div className="flex items-center gap-2">
            <Spinner />
            <p className="text-sm text-muted-foreground">Loading...</p>
          </div>
        )}

        {mine.length > 0 && (
          <section className="flex flex-col gap-4">
            {mine.map((backend) => (
              <div key={backend.id} className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium">{backend.label}</p>
                  <StatusText tone="ok">Connected</StatusText>
                  {backend.query.hasAuth && <MetaText>Auth</MetaText>}
                  {backend.query.hasOrgId && <MetaText>{`Tenant`}</MetaText>}
                </div>
                <p className="text-sm text-muted-foreground">
                  {backend.query.url}
                </p>
                {backend.rules === null ? (
                  /* Said on the card rather than discovered at 3am: this is the
                     difference between an investigation that can close itself
                     and one that never can. */
                  <p className="flex items-start gap-2 text-sm text-warn">
                    <TriangleAlert {...ICON_UI} className="shrink-0" />
                    <span>
                      No rules endpoint. Investigations cannot confirm an alert
                      stopped firing through this backend, so they will not
                      reach Resolved on their own.
                    </span>
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Rules: {backend.rules.url}
                  </p>
                )}
                <Button
                  size="xs"
                  variant="secondary"
                  className="self-start"
                  onClick={() => setConfirmRemove(backend.id)}
                >
                  Disconnect
                </Button>
              </div>
            ))}
          </section>
        )}

        <section className="flex flex-col gap-4">
          <h2 className="text-sm font-medium">
            {mine.length > 0 ? "Connect another" : "Connect"}
          </h2>

          {content.warnings.map((warning) => (
            <Alert key={warning}>
              <TriangleAlert {...ICON_UI} />
              <AlertDescription>{warning}</AlertDescription>
            </Alert>
          ))}

          <Field>
            <FieldLabel htmlFor="metrics-query-url">Query URL</FieldLabel>
            <FieldDescription>{content.queryHelp}</FieldDescription>
            <Input
              className="max-w-control"
              id="metrics-query-url"
              placeholder={content.queryPlaceholder}
              value={query.url}
              onChange={(e) =>
                setQuery({ ...query, url: e.currentTarget.value })
              }
            />
          </Field>
          <EndpointFields
            idPrefix="metrics-query"
            draft={query}
            onChange={setQuery}
            authHelp={content.authHelp}
          />

          <Field>
            <FieldLabel htmlFor="metrics-rules-url">
              Rules URL (optional)
            </FieldLabel>
            <FieldDescription>{content.rulesHelp}</FieldDescription>
            <Input
              className="max-w-control"
              id="metrics-rules-url"
              placeholder={content.rulesPlaceholder}
              value={rules.url}
              onChange={(e) =>
                setRules({ ...rules, url: e.currentTarget.value })
              }
            />
          </Field>
          {rules.url.trim() !== "" && (
            <EndpointFields
              idPrefix="metrics-rules"
              draft={rules}
              onChange={setRules}
              authHelp="The rules endpoint often wants its own credential - on Grafana Cloud a service account token rather than the metrics one."
            />
          )}

          {connectError !== null && (
            <Alert variant="destructive">
              <AlertTitle>Could not connect</AlertTitle>
              <AlertDescription>{connectError}</AlertDescription>
            </Alert>
          )}

          <Button
            className="self-start"
            disabled={query.url.trim() === "" || connect.isPending}
            onClick={() => connect.mutate()}
          >
            {connect.isPending && <Spinner className="size-4" />}
            Connect
          </Button>
        </section>
      </div>

      <ConfirmDialog
        open={confirmRemove !== null}
        onOpenChange={(open) => !open && setConfirmRemove(null)}
        title={`Disconnect ${identity.label}?`}
        description="Investigations lose metric evidence from this backend until it is reconnected."
        confirmLabel="Disconnect"
        destructive
        onConfirm={() => {
          if (confirmRemove !== null) disconnect.mutate(confirmRemove);
          setConfirmRemove(null);
        }}
      />
    </Page>
  );
}
