import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import type {
  MetricsConnectInput,
  MetricsEndpointInput,
  MetricsSourceKind,
  MetricsSourceStatus,
} from "@nightwarden/shared";

import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/alert";
import { MetaText, StatusText } from "@/shared/ui/status";
import { Button } from "@/shared/ui/button";
import { Checkbox } from "@/shared/ui/checkbox";
import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";
import { Field, FieldLabel, FieldDescription } from "@/shared/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import { Spinner } from "@/shared/ui/spinner";
import { Page, SectionHeading } from "@/shared/ui/Page";
import { ConfirmDialog } from "@/shared/ui/ConfirmDialog";
import { IntegrationHeader } from "@/features/integrations/IntegrationHeader";
import { IntegrationWarnings } from "@/features/integrations/IntegrationWarnings";
import { ICON_UI } from "@/shared/lib/iconProps";
import { toast } from "@/shared/lib/toast";
import { ApiError, apiFetch } from "@/shared/api/client";
import { useDisconnect } from "../useIntegration";
import {
  AUTH_LABEL,
  METRICS_SOURCE_CONTENT,
  QUERY_LEAD,
  RULES_LEAD,
  type AuthMethod,
} from "./content";
import { INTEGRATION_CATALOG } from "../catalog";

// The method decides which fields travel, so a credential the user switched
// away from is never sent beside the one they chose.
interface Credential {
  method: AuthMethod;
  bearer: string;
  username: string;
  password: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  sessionToken: string;
}

const emptyCredential = (method: AuthMethod): Credential => ({
  method,
  bearer: "",
  username: "",
  password: "",
  accessKeyId: "",
  secretAccessKey: "",
  region: "",
  sessionToken: "",
});

const trim = (v: string): string => v.trim();

function endpointOf(
  url: string,
  credential: Credential,
  orgId: string,
): MetricsEndpointInput {
  const tenant = trim(orgId) === "" ? {} : { orgId: trim(orgId) };
  switch (credential.method) {
    case "bearer":
      return {
        url: trim(url),
        ...(trim(credential.bearer) && { authHeader: trim(credential.bearer) }),
        ...tenant,
      };
    case "basic":
      return {
        url: trim(url),
        ...(trim(credential.username) && {
          basicUsername: trim(credential.username),
        }),
        ...(trim(credential.password) && {
          basicPassword: trim(credential.password),
        }),
        ...tenant,
      };
    case "aws":
      return {
        url: trim(url),
        ...(trim(credential.accessKeyId) && {
          accessKeyId: trim(credential.accessKeyId),
        }),
        ...(trim(credential.secretAccessKey) && {
          secretAccessKey: trim(credential.secretAccessKey),
        }),
        ...(trim(credential.region) && { region: trim(credential.region) }),
        ...(trim(credential.sessionToken) && {
          sessionToken: trim(credential.sessionToken),
        }),
      };
    case "none":
      return { url: trim(url), ...tenant };
  }
}

function CredentialFields({
  idPrefix,
  credential,
  onChange,
}: {
  idPrefix: string;
  credential: Credential;
  onChange: (next: Credential) => void;
}): React.JSX.Element | null {
  const set = (patch: Partial<Credential>): void =>
    onChange({ ...credential, ...patch });

  if (credential.method === "none") return null;

  if (credential.method === "bearer") {
    return (
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-bearer`}>
          Authorization header
        </FieldLabel>
        <FieldDescription>
          The whole header value, scheme included.
        </FieldDescription>
        <Input
          id={`${idPrefix}-bearer`}
          type="password"
          placeholder="Bearer ..."
          value={credential.bearer}
          onChange={(e) => set({ bearer: e.currentTarget.value })}
        />
      </Field>
    );
  }

  if (credential.method === "basic") {
    /* One credential, so one row: a pair entered together and sent together
       reads as two unrelated questions when it is stacked. */
    return (
      <div className="flex flex-wrap gap-4">
        <Field className="w-auto">
          <FieldLabel htmlFor={`${idPrefix}-user`}>Username</FieldLabel>
          <Input
            id={`${idPrefix}-user`}
            measure="short"
            value={credential.username}
            onChange={(e) => set({ username: e.currentTarget.value })}
          />
        </Field>
        <Field className="w-auto">
          <FieldLabel htmlFor={`${idPrefix}-pass`}>Password</FieldLabel>
          <Input
            id={`${idPrefix}-pass`}
            type="password"
            measure="short"
            value={credential.password}
            onChange={(e) => set({ password: e.currentTarget.value })}
          />
        </Field>
      </div>
    );
  }

  return (
    <>
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-access-key`}>
          Access key ID
        </FieldLabel>
        <Input
          id={`${idPrefix}-access-key`}
          measure="short"
          placeholder="AKIA..."
          value={credential.accessKeyId}
          onChange={(e) => set({ accessKeyId: e.currentTarget.value })}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-secret-key`}>
          Secret access key
        </FieldLabel>
        <Input
          id={`${idPrefix}-secret-key`}
          type="password"
          value={credential.secretAccessKey}
          onChange={(e) => set({ secretAccessKey: e.currentTarget.value })}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-region`}>Region</FieldLabel>
        <Input
          id={`${idPrefix}-region`}
          measure="short"
          placeholder="us-east-1"
          value={credential.region}
          onChange={(e) => set({ region: e.currentTarget.value })}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-session-token`}>
          Session token
        </FieldLabel>
        <FieldDescription>Only for temporary STS credentials.</FieldDescription>
        <Input
          id={`${idPrefix}-session-token`}
          type="password"
          value={credential.sessionToken}
          onChange={(e) => set({ sessionToken: e.currentTarget.value })}
        />
      </Field>
    </>
  );
}

function AuthPicker({
  id,
  methods,
  help,
  value,
  onChange,
}: {
  id: string;
  methods: AuthMethod[];
  help: string;
  value: AuthMethod;
  onChange: (next: AuthMethod) => void;
}): React.JSX.Element | null {
  // A product that offers one way in is not asking a question.
  if (methods.length < 2) return null;
  const items = Object.fromEntries(methods.map((m) => [m, AUTH_LABEL[m]]));
  return (
    <Field>
      <FieldLabel htmlFor={id}>Authentication</FieldLabel>
      {help !== "" && <FieldDescription>{help}</FieldDescription>}
      <Select
        items={items}
        value={value}
        onValueChange={(next) => onChange(next as AuthMethod)}
      >
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {methods.map((m) => (
            <SelectItem key={m} value={m}>
              {AUTH_LABEL[m]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

function ConnectForm({ kind }: { kind: MetricsSourceKind }): React.JSX.Element {
  const content = METRICS_SOURCE_CONTENT[kind];
  const identity = INTEGRATION_CATALOG[kind];
  const queryClient = useQueryClient();
  const defaultMethod = content.auth[0] ?? "none";

  const [queryUrl, setQueryUrl] = useState("");
  const [queryCredential, setQueryCredential] = useState(
    emptyCredential(defaultMethod),
  );
  const [orgId, setOrgId] = useState("");
  const [rulesUrl, setRulesUrl] = useState("");
  const [sameCredential, setSameCredential] = useState(true);
  const [rulesCredential, setRulesCredential] = useState(
    emptyCredential(defaultMethod),
  );
  const [error, setError] = useState<string | null>(null);

  const connect = useMutation({
    mutationFn: () => {
      const body: MetricsConnectInput = {
        kind,
        query: endpointOf(queryUrl, queryCredential, orgId),
        // Absent rather than empty: a source with no rules endpoint is a
        // supported configuration, and the row above says what it costs.
        ...(trim(rulesUrl) !== "" && {
          rules: endpointOf(
            rulesUrl,
            sameCredential ? queryCredential : rulesCredential,
            orgId,
          ),
        }),
      };
      return apiFetch<MetricsSourceStatus>("/api/integrations/metrics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    },
    onMutate: () => setError(null),
    onSuccess: async () => {
      toast.success(`${identity.label} connected`);
      await queryClient.invalidateQueries({ queryKey: ["metrics-sources"] });
    },
    onError: (err) =>
      setError(
        err instanceof ApiError ? err.message : "Could not reach the API",
      ),
  });

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-4">
        <SectionHeading lead={QUERY_LEAD}>Querying</SectionHeading>
        <Field>
          <FieldLabel htmlFor="metrics-query-url">Query URL</FieldLabel>
          {content.queryHelp !== "" && (
            <FieldDescription>{content.queryHelp}</FieldDescription>
          )}
          <Input
            id="metrics-query-url"
            placeholder={content.queryPlaceholder}
            value={queryUrl}
            onChange={(e) => setQueryUrl(e.currentTarget.value)}
          />
        </Field>
        <AuthPicker
          id="metrics-query-auth"
          methods={content.auth}
          help={content.authHelp}
          value={queryCredential.method}
          onChange={(method) =>
            setQueryCredential({ ...queryCredential, method })
          }
        />
        <CredentialFields
          idPrefix="metrics-query"
          credential={queryCredential}
          onChange={setQueryCredential}
        />
        {content.tenant && (
          <Field>
            <FieldLabel htmlFor="metrics-tenant">Tenant</FieldLabel>
            <FieldDescription>
              The tenant to query, sent as X-Scope-OrgID.
            </FieldDescription>
            <Input
              id="metrics-tenant"
              measure="short"
              value={orgId}
              onChange={(e) => setOrgId(e.currentTarget.value)}
            />
          </Field>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <SectionHeading lead={RULES_LEAD}>Recovery</SectionHeading>
        <Field>
          <FieldLabel htmlFor="metrics-rules-url">Rules URL</FieldLabel>
          <FieldDescription>{content.rulesHelp}</FieldDescription>
          <Input
            id="metrics-rules-url"
            placeholder={content.rulesPlaceholder}
            value={rulesUrl}
            onChange={(e) => setRulesUrl(e.currentTarget.value)}
          />
        </Field>
        {trim(rulesUrl) !== "" && (
          <>
            <Field orientation="horizontal">
              <Checkbox
                id="metrics-rules-same"
                checked={sameCredential}
                onCheckedChange={(next) => setSameCredential(next === true)}
              />
              <Label htmlFor="metrics-rules-same">
                Use the same credentials
              </Label>
            </Field>
            {!sameCredential && (
              <>
                <AuthPicker
                  id="metrics-rules-auth"
                  methods={content.auth}
                  help=""
                  value={rulesCredential.method}
                  onChange={(method) =>
                    setRulesCredential({ ...rulesCredential, method })
                  }
                />
                <CredentialFields
                  idPrefix="metrics-rules"
                  credential={rulesCredential}
                  onChange={setRulesCredential}
                />
              </>
            )}
          </>
        )}
      </section>

      <IntegrationWarnings warnings={content.warnings} />

      {error !== null && (
        <Alert variant="destructive">
          <AlertTitle>Could not connect</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Button
        className="self-start"
        disabled={trim(queryUrl) === "" || connect.isPending}
        onClick={() => connect.mutate()}
      >
        {connect.isPending && <Spinner className="size-4" />}
        Connect
      </Button>
    </div>
  );
}

function ConnectedSource({
  source,
  onRemove,
}: {
  source: MetricsSourceStatus;
  onRemove: () => void;
}): React.JSX.Element {
  return (
    /* The header above names the product, so the address is what identifies
       this connection - the same line Loki's connected state shows. */
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <p className="text-sm font-medium">{source.query?.url}</p>
        <StatusText tone="ok">Connected</StatusText>
        {source.query?.hasAuth && <MetaText>Auth</MetaText>}
        {source.query?.hasOrgId && <MetaText>Tenant</MetaText>}
      </div>
      {source.rules === null ? (
        /* Said here rather than discovered at 3am: this is the difference
           between an investigation that can close itself and one that cannot. */
        <p className="flex items-start gap-2 text-sm text-warning">
          <TriangleAlert {...ICON_UI} className="shrink-0" />
          <span>
            No rules endpoint. This source reaches Resolved only when your alert
            source sends a resolved notification.
          </span>
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          Rules: {source.rules.url}
        </p>
      )}
      <Button
        size="sm"
        variant="secondary"
        className="self-start"
        onClick={onRemove}
      >
        Disconnect
      </Button>
    </div>
  );
}

export function MetricsSourcePage({
  kind,
}: {
  kind: MetricsSourceKind;
}): React.JSX.Element {
  const identity = INTEGRATION_CATALOG[kind];
  const [confirmRemove, setConfirmRemove] = useState(false);

  const { data: status, isLoading } = useQuery<MetricsSourceStatus>({
    queryKey: ["metrics-sources"],
    queryFn: () => apiFetch<MetricsSourceStatus>("/api/integrations/metrics"),
  });

  // One source across every product, so a card is connected, free, or blocked
  // by whichever other product holds the slot.
  const connected = status?.configured === true && status.kind === kind;
  const heldByAnother = status?.configured === true && status.kind !== kind;

  const disconnect = useDisconnect({
    label: identity.label,
    queryKey: ["metrics-sources"],
    endpoint: () => "/api/integrations/metrics",
  });

  return (
    <Page
      measure="form"
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

        {connected && status !== undefined && (
          <ConnectedSource
            source={status}
            onRemove={() => setConfirmRemove(true)}
          />
        )}

        {heldByAnother && (
          <Alert variant="warning">
            <AlertTitle>Another metrics source is connected</AlertTitle>
            <AlertDescription>
              NightWarden queries one metrics source. Disconnect {status?.label}{" "}
              first to connect {identity.label} instead.
            </AlertDescription>
          </Alert>
        )}

        {!connected && !heldByAnother && !isLoading && (
          <ConnectForm kind={kind} />
        )}
      </div>

      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={`Disconnect ${identity.label}?`}
        description="Investigations lose metric evidence from this source until it is reconnected."
        confirmLabel="Disconnect"
        destructive
        onConfirm={() => disconnect.mutate()}
      />
    </Page>
  );
}
