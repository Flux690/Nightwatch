import { useEffect, useState } from "react";
import { Link, useBlocker, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AgentConfig,
  CatalogError,
  LLMProviderName,
  ModelCatalog,
  ProviderOption,
  ProviderSettings,
} from "@nightwarden/shared";

import { Page } from "@/components/layout/Page";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/lib/toast";
import { apiFetch } from "@/api/client";
import { ConfirmDialog } from "@/components/layout/ConfirmDialog";
import { AccountSection } from "@/components/layout/settings/AccountSection";
import { LimitsSection } from "@/components/layout/settings/LimitsSection";
import {
  ProviderSection,
  type CatalogState,
} from "@/components/layout/settings/ProviderSection";
import { SandboxSection } from "@/components/layout/settings/SandboxSection";
import { useConfig, useConfigAutosave } from "@/hooks/useConfig";
import { useDebounced } from "@/hooks/useDebounced";
import { useAuth } from "@/auth/AuthContext";

const CATALOG_ERRORS: Record<CatalogError, string> = {
  needs_key: "Add an API key to load models.",
  bad_key: "That key was rejected. Check it and try again.",
  unreachable: "Could not reach that endpoint. Check the Base URL.",
};

const CATALOG_DEBOUNCE_MS = 500;

const SECTIONS = [
  { id: "provider", label: "Provider" },
  { id: "limits", label: "Limits" },
  { id: "sandbox", label: "Sandbox" },
  { id: "account", label: "Account" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

const EDITABLE_PROVIDER_FIELDS = [
  "model",
  "baseUrl",
  "reasoningLevel",
] as const satisfies readonly (keyof ProviderSettings)[];

type ProviderDelta = Partial<
  Record<
    LLMProviderName,
    Partial<Pick<ProviderSettings, (typeof EDITABLE_PROVIDER_FIELDS)[number]>>
  >
>;

function buildProviderDelta(
  form: AgentConfig,
  base: AgentConfig,
): ProviderDelta {
  const delta: ProviderDelta = {};
  for (const name of Object.keys(form.providers) as LLMProviderName[]) {
    const blockDelta: Record<string, unknown> = {};
    for (const key of EDITABLE_PROVIDER_FIELDS) {
      if (!Object.is(form.providers[name][key], base.providers[name][key])) {
        blockDelta[key] = form.providers[name][key];
      }
    }
    if (Object.keys(blockDelta).length > 0) delta[name] = blockDelta;
  }
  return delta;
}

export function SettingsPage(): React.JSX.Element {
  const { section } = useParams({ strict: false }) as { section?: string };
  const active: SectionId =
    SECTIONS.find((s) => s.id === section)?.id ?? "provider";

  const { logoutAll } = useAuth();
  const config = useConfig();
  const save = useConfigAutosave();
  const queryClient = useQueryClient();

  // The provider block is a draft, seeded once and held while it is edited: a
  // background refetch would otherwise replace what is being typed.
  const [form, setForm] = useState<AgentConfig | null>(null);
  const [newApiKey, setNewApiKey] = useState("");
  useEffect(() => {
    setForm((prev) => prev ?? config ?? null);
  }, [config]);

  const { data: providersData } = useQuery<{ providers: ProviderOption[] }>({
    queryKey: ["config/providers"],
    queryFn: () =>
      apiFetch<{ providers: ProviderOption[] }>("/api/config/providers").catch(
        () => ({ providers: [] }),
      ),
    staleTime: Infinity,
  });
  const availableProviders = providersData?.providers ?? [];

  const editedProvider = form?.provider ?? null;
  const editedBaseUrl = editedProvider
    ? (form?.providers[editedProvider].baseUrl ?? "")
    : "";
  const catalogInput = useDebounced(
    { provider: editedProvider, baseUrl: editedBaseUrl, apiKey: newApiKey },
    CATALOG_DEBOUNCE_MS,
  );

  const { data: catalogData, isPending: catalogPending } =
    useQuery<ModelCatalog>({
      queryKey: [
        "config/models",
        catalogInput.provider,
        catalogInput.baseUrl,
        catalogInput.apiKey,
      ],
      queryFn: () =>
        apiFetch<ModelCatalog>("/api/config/models", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...(catalogInput.provider && { provider: catalogInput.provider }),
            ...(catalogInput.baseUrl && { baseUrl: catalogInput.baseUrl }),
            ...(catalogInput.apiKey.trim() && {
              apiKey: catalogInput.apiKey.trim(),
            }),
          }),
        }).catch<ModelCatalog>(() => ({ ok: false, error: "unreachable" })),
      staleTime: 30_000,
      enabled: catalogInput.provider !== null,
    });

  const saveConfig = useMutation({
    mutationFn: (providers: ProviderDelta) =>
      apiFetch<AgentConfig>("/api/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(form?.provider !== config?.provider && {
            provider: form?.provider,
          }),
          providers,
        }),
      }),
  });

  const saveApiKey = useMutation({
    mutationFn: (vars: { provider: LLMProviderName; apiKey: string }) =>
      apiFetch<{ apiKeyMasked: string }>("/api/config/key", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(vars),
      }),
  });

  const block = form?.provider ? form.providers[form.provider] : null;
  const savedBlock = form?.provider
    ? (config?.providers[form.provider] ?? null)
    : null;

  const catalog: CatalogState = ((): CatalogState => {
    const settled = catalogInput.provider === form?.provider;
    if (!settled || catalogPending || catalogData === undefined) {
      return { kind: "loading" };
    }
    if (!catalogData.ok) {
      return { kind: "empty", message: CATALOG_ERRORS[catalogData.error] };
    }
    if (catalogData.models.length === 0) {
      return { kind: "empty", message: "This endpoint listed no models." };
    }
    return { kind: "ready", models: catalogData.models };
  })();
  const availableModels = catalog.kind === "ready" ? catalog.models : [];

  function patchProvider(
    name: LLMProviderName,
    patch: Record<string, unknown>,
  ): void {
    setForm((prev) =>
      prev
        ? {
            ...prev,
            providers: {
              ...prev.providers,
              [name]: { ...prev.providers[name], ...patch },
            },
          }
        : prev,
    );
  }

  function setProviderField<K extends keyof ProviderSettings>(
    key: K,
    value: ProviderSettings[K],
  ): void {
    if (!form?.provider) return;
    patchProvider(form.provider, { [key]: value });
  }

  function setModel(id: string | null): void {
    if (!form?.provider) return;
    if (id === null) {
      patchProvider(form.provider, {
        model: null,
        reasoning: null,
        reasoningLevel: null,
      });
      return;
    }
    const reasoning =
      availableModels.find((m) => m.id === id)?.reasoning ?? null;
    const keeps = reasoning?.levels.some(
      (l) => l.value === block?.reasoningLevel,
    );
    patchProvider(form.provider, {
      model: id,
      reasoning,
      reasoningLevel: reasoning
        ? keeps
          ? block?.reasoningLevel
          : reasoning.defaultLevel
        : null,
    });
  }

  const providerDelta =
    form && config ? buildProviderDelta(form, config) : ({} as ProviderDelta);
  const providerDirty =
    Object.keys(providerDelta).length > 0 ||
    newApiKey.trim() !== "" ||
    (form != null && config != null && form.provider !== config.provider);
  const unchosen = form?.provider != null && !block?.model;

  async function handleSaveProvider(): Promise<void> {
    if (!form?.provider) return;
    const keyToSave = newApiKey.trim();
    try {
      // The key goes first and alone: saving the block looks the chosen model up
      // in the catalog, which needs that key already stored.
      if (keyToSave) {
        await saveApiKey.mutateAsync({
          provider: form.provider,
          apiKey: keyToSave,
        });
      }
      await saveConfig.mutateAsync(providerDelta);
      await queryClient.invalidateQueries({ queryKey: ["config"] });
      setNewApiKey("");
      toast.show({
        title: "Settings saved",
        message: "Your changes have been saved.",
        variant: "success",
      });
    } catch (err) {
      toast.show({
        title: "Save failed",
        message: err instanceof Error ? err.message : "Unknown error",
        variant: "error",
      });
    }
  }

  // Only the provider block can be lost, so only it asks. Everything else is
  // already written by the time you leave.
  const blocker = useBlocker({
    shouldBlockFn: () => true,
    disabled: !providerDirty,
    enableBeforeUnload: () => providerDirty,
    withResolver: true,
  });

  return (
    <Page
      crumbs={[{ label: "Settings" }]}
      controls={
        <Tabs value={active}>
          <TabsList variant="line" aria-label="Settings sections">
            {SECTIONS.map((s) => (
              <TabsTrigger
                key={s.id}
                value={s.id}
                // A tab is an address here, so it renders as a link rather
                // than a button and Base UI is told not to expect one.
                nativeButton={false}
                render={
                  <Link to="/settings/$section" params={{ section: s.id }} />
                }
              >
                {s.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      }
    >
      {config && form && active === "provider" && (
        <ProviderSection
          form={form}
          block={block}
          savedApiKeyMasked={savedBlock?.apiKeyMasked ?? null}
          catalog={catalog}
          providers={availableProviders}
          newApiKey={newApiKey}
          dirty={providerDirty}
          saving={saveConfig.isPending || saveApiKey.isPending}
          unchosen={unchosen}
          onProviderChange={(provider) =>
            setForm((prev) => (prev ? { ...prev, provider } : prev))
          }
          onProviderField={setProviderField}
          onModelChange={setModel}
          onApiKeyChange={setNewApiKey}
          onSave={() => void handleSaveProvider()}
        />
      )}
      {config && active === "limits" && (
        <LimitsSection config={config} save={save} />
      )}
      {config && active === "sandbox" && (
        <SandboxSection config={config} save={save} />
      )}
      {active === "account" && (
        <AccountSection onLogoutAll={() => void logoutAll()} />
      )}

      <ConfirmDialog
        open={blocker.status === "blocked"}
        onOpenChange={(o) => {
          if (!o && blocker.status === "blocked") blocker.reset();
        }}
        title="Leave without saving?"
        description="The provider, key and model you edited will be lost."
        confirmLabel="Leave"
        destructive
        onConfirm={() => {
          if (blocker.status === "blocked") blocker.proceed();
        }}
      />
    </Page>
  );
}
