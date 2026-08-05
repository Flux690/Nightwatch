import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AgentConfig,
  CatalogError,
  LLMProviderName,
  ModelCatalog,
  ModelOption,
  ProviderOption,
  ProviderSettings,
} from "@nightwarden/shared";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ICON_UI } from "@/lib/iconProps";
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
import { useDebounced } from "@/hooks/useDebounced";
import { useAuth } from "@/auth/AuthContext";

// Loading the catalog is what verifies a provider block, so these are the ways it
// can go wrong. Each is the server's answer: guessing from a blank key field cannot
// tell a provider that publishes its catalog from one that demands a credential.
const CATALOG_ERRORS: Record<CatalogError, string> = {
  needs_key: "Add an API key to load models.",
  bad_key: "That key was rejected. Check it and try again.",
  unreachable: "Could not reach that endpoint. Check the Base URL.",
};

// Long enough that typing a key fires one request, short enough to feel instant.
const CATALOG_DEBOUNCE_MS = 500;

type SectionId = "model" | "limits" | "sandbox" | "account";

const SECTIONS: { id: SectionId; label: string; description: string }[] = [
  {
    id: "model",
    label: "Provider",
    description:
      "Which model answers, how to reach it, and how hard it works on each request.",
  },
  {
    id: "limits",
    label: "Limits",
    description:
      "How long a single investigation may run, and how many times it retries before giving up.",
  },
  {
    id: "sandbox",
    label: "Sandbox",
    description:
      "Lifecycle and resource limits for per-session code sandboxes.",
  },
  {
    id: "account",
    label: "Account",
    description: "Session control for every signed-in device.",
  },
];

// Only these three are the operator's to send. The rest of a provider block is
// computed server-side: the mask on read, and the model's own limits when a
// model is picked.
const EDITABLE_PROVIDER_FIELDS = [
  "model",
  "baseUrl",
  "reasoningLevel",
] as const satisfies readonly (keyof ProviderSettings)[];

// The patch the API accepts: global fields flat, provider fields nested under the
// provider they belong to.
type ConfigDelta = Partial<Omit<AgentConfig, "providers">> & {
  providers?: Partial<
    Record<
      LLMProviderName,
      Partial<Pick<ProviderSettings, (typeof EDITABLE_PROVIDER_FIELDS)[number]>>
    >
  >;
};

function buildDelta(form: AgentConfig, base: AgentConfig): ConfigDelta {
  const delta: ConfigDelta = {};
  for (const key of Object.keys(form) as (keyof AgentConfig)[]) {
    if (key === "providers") continue;
    if (!Object.is(form[key], base[key])) {
      Object.assign(delta, { [key]: form[key] });
    }
  }

  // Every block the config carries, so a new provider needs no list updating.
  for (const name of Object.keys(form.providers) as LLMProviderName[]) {
    const formBlock = form.providers[name];
    const baseBlock = base.providers[name];
    const blockDelta: Record<string, unknown> = {};
    for (const key of EDITABLE_PROVIDER_FIELDS) {
      if (!Object.is(formBlock[key], baseBlock[key])) {
        blockDelta[key] = formBlock[key];
      }
    }
    if (Object.keys(blockDelta).length > 0) {
      delta.providers = { ...delta.providers, [name]: blockDelta };
    }
  }
  return delta;
}

export function SettingsModal({
  opened,
  onClose,
}: {
  opened: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const { logoutAll } = useAuth();
  const [section, setSection] = useState<SectionId>("model");
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // Never refetched while the modal is open. The form seeds from this once and then
  // holds what was typed, so a background refetch on window focus would be a read
  // whose only possible effect is to race the operator mid-edit.
  const { data: config } = useQuery<AgentConfig>({
    queryKey: ["config"],
    queryFn: () => apiFetch<AgentConfig>("/api/config"),
    enabled: opened,
    staleTime: Infinity,
  });

  const { data: providersData } = useQuery<{ providers: ProviderOption[] }>({
    queryKey: ["config/providers"],
    queryFn: () =>
      apiFetch<{ providers: ProviderOption[] }>("/api/config/providers").catch(
        () => ({ providers: [] }),
      ),
    staleTime: Infinity,
    enabled: opened,
  });

  const availableProviders = providersData?.providers ?? [];

  const queryClient = useQueryClient();
  const [form, setForm] = useState<AgentConfig | null>(null);
  const [newApiKey, setNewApiKey] = useState("");

  // Seeded once per opening, never re-seeded while open: a background refetch
  // (window focus is enough) would otherwise replace whatever is being typed with
  // the saved values, silently reverting the provider and inerting its fields.
  useEffect(() => {
    if (!opened) {
      setForm(null);
      return;
    }
    setForm((prev) => prev ?? config ?? null);
  }, [opened, config]);

  // The catalog describes the block being edited, so it reloads whenever the
  // provider, endpoint or key changes. Debounced because the key is typed a
  // character at a time and each change would otherwise be its own request.
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
      enabled: opened && catalogInput.provider !== null,
    });

  const saveConfig = useMutation({
    mutationFn: (delta: ConfigDelta) =>
      apiFetch<AgentConfig>("/api/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(delta),
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

  async function handleSave(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!form || !config) return;
    const delta = buildDelta(form, config);
    // The textarea keeps raw lines while typing; blanks are dropped on save.
    if (delta.sandboxAllowlistHosts !== undefined) {
      delta.sandboxAllowlistHosts = delta.sandboxAllowlistHosts
        .map((h) => h.trim())
        .filter((h) => h.length > 0);
    }
    const keyToSave = newApiKey.trim();
    if (Object.keys(delta).length === 0 && !keyToSave) return;
    // A key belongs to the provider whose block is on screen, not to whichever
    // one happens to be active, so an unsaved provider switch files it correctly.
    const keyProvider = form.provider;
    if (keyToSave && keyProvider === null) return;

    try {
      // The key goes first and alone: saving the config looks the chosen model
      // up in the catalog, which needs that key already stored. In parallel the
      // lookup races the write and the model's limits come back empty.
      if (keyToSave && keyProvider) {
        await saveApiKey.mutateAsync({
          provider: keyProvider,
          apiKey: keyToSave,
        });
      }
      if (Object.keys(delta).length > 0) await saveConfig.mutateAsync(delta);
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

  function setField<K extends keyof AgentConfig>(
    key: K,
    value: AgentConfig[K],
  ): void {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

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

  // Fields every provider has, applied to whichever is selected, so switching
  // provider swaps which credentials and endpoint are on screen.
  function setProviderField<K extends keyof ProviderSettings>(
    key: K,
    value: ProviderSettings[K],
  ): void {
    if (!form?.provider) return;
    patchProvider(form.provider, { [key]: value });
  }

  // Everything below the provider picker describes one provider, so it only has
  // meaning once one is chosen.
  const block = form?.provider ? form.providers[form.provider] : null;
  // What the server holds for that provider, read live rather than from the
  // frozen form: a key saved a moment ago must show as saved, and the form is
  // deliberately not re-seeded while it is open.
  const savedBlock = form?.provider
    ? (config?.providers[form.provider] ?? null)
    : null;
  // One value carries the catalog's whole state, so the dropdown never shows one
  // half-arrived answer while another is still on its way.
  const catalog: CatalogState = ((): CatalogState => {
    // The debounced input still trails the form, so the answer on hand is about
    // a provider the operator has already moved away from.
    const settled = catalogInput.provider === form?.provider;
    if (!settled || catalogPending || catalogData === undefined) {
      return { kind: "loading" };
    }
    if (!catalogData.ok) {
      return { kind: "empty", message: CATALOG_ERRORS[catalogData.error] };
    }
    if (catalogData.models.length === 0) {
      return {
        kind: "empty",
        message: "This endpoint listed no models. You can still type an id.",
      };
    }
    return { kind: "ready", models: catalogData.models };
  })();

  const availableModels = catalog.kind === "ready" ? catalog.models : [];

  // The ladder belongs to the model, so it is captured alongside it and the
  // control is drawn from the config rather than from a request. An id with no
  // catalog entry carries no ladder rather than the previous model's.
  function setModel(id: string): void {
    if (!form?.provider) return;
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

  const keyDirty = newApiKey.trim() !== "";
  const configDirty =
    form && config ? Object.keys(buildDelta(form, config)).length > 0 : false;
  const dirty = configDirty || keyDirty;

  /* Closing with unsaved edits asks first; a discarded form re-syncs to the persisted config so a re-open never shows stale edits. */
  function handleClose(): void {
    if (dirty) {
      setConfirmDiscard(true);
      return;
    }
    setNewApiKey("");
    onClose();
  }

  function confirmDiscardEdits(): void {
    setForm(config ?? null);
    setNewApiKey("");
    setConfirmDiscard(false);
    onClose();
  }

  const active = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];

  return (
    <Dialog
      open={opened}
      onOpenChange={(o) => {
        if (!o) handleClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="gap-0 overflow-hidden p-0 shadow-overlay sm:max-w-page"
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">
          Configure the investigation agent's provider, API key, run limits,
          sandbox and account.
        </DialogDescription>

        <Tabs
          orientation="vertical"
          value={section}
          onValueChange={(v) => setSection(v as SectionId)}
          className="grid h-[min(640px,85vh)] grid-cols-1 grid-rows-[auto_1fr] gap-0 sm:grid-cols-[210px_minmax(0,1fr)] sm:grid-rows-[minmax(0,1fr)]"
        >
          <div className="flex flex-col border-b border-border bg-surface p-2 max-sm:flex-row max-sm:overflow-x-auto sm:border-b-0 sm:border-r sm:px-2 sm:py-4">
            <h2 className="mb-3 px-3 text-sm font-medium uppercase tracking-[0.06em] text-muted-foreground max-sm:hidden">
              Settings
            </h2>
            <TabsList
              variant="line"
              aria-label="Settings sections"
              className="flex w-full flex-col gap-1 rounded-none bg-transparent p-0 max-sm:flex-row max-sm:overflow-x-auto"
            >
              {SECTIONS.map((s) => (
                <TabsTrigger
                  key={s.id}
                  value={s.id}
                  className="justify-start rounded-md bg-transparent px-3 py-2 text-muted-foreground hover:bg-surface-hover hover:text-foreground data-active:!bg-surface-hover data-active:text-foreground max-sm:w-auto max-sm:whitespace-nowrap after:hidden"
                >
                  {s.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          <div className="relative flex min-h-0 min-w-0 flex-col bg-card">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Close settings"
              className="absolute right-3 top-3 z-[1]"
              onClick={handleClose}
            >
              <X {...ICON_UI} />
            </Button>

            <form
              onSubmit={handleSave}
              className="flex min-h-0 flex-1 flex-col"
            >
              <ScrollArea className="min-h-0 flex-1">
                <div className="p-6">
                  <h3 className="mb-1 text-lg font-semibold tracking-[-0.2px] text-foreground">
                    {active.label}
                  </h3>
                  <p className="mb-6 text-sm text-muted-foreground">
                    {active.description}
                  </p>

                  <TabsContent value="model">
                    {form && (
                      <ProviderSection
                        form={form}
                        block={block}
                        savedApiKeyMasked={savedBlock?.apiKeyMasked ?? null}
                        catalog={catalog}
                        providers={availableProviders}
                        newApiKey={newApiKey}
                        onProviderChange={(provider) =>
                          setField("provider", provider)
                        }
                        onProviderField={setProviderField}
                        onModelChange={setModel}
                        onApiKeyChange={setNewApiKey}
                      />
                    )}
                  </TabsContent>

                  <TabsContent value="limits">
                    {form && <LimitsSection form={form} setField={setField} />}
                  </TabsContent>

                  <TabsContent value="sandbox">
                    {form && <SandboxSection form={form} setField={setField} />}
                  </TabsContent>

                  <TabsContent value="account">
                    <AccountSection onLogoutAll={() => void logoutAll()} />
                  </TabsContent>
                </div>
              </ScrollArea>

              <div className="flex items-center justify-end gap-2 px-6 py-2">
                <Button
                  type="submit"
                  disabled={
                    !dirty || saveConfig.isPending || saveApiKey.isPending
                  }
                >
                  {(saveConfig.isPending || saveApiKey.isPending) && (
                    <Spinner className="size-4" />
                  )}
                  Save
                </Button>
              </div>
            </form>
          </div>
        </Tabs>
      </DialogContent>
      <ConfirmDialog
        open={confirmDiscard}
        onOpenChange={(o) => {
          if (!o) setConfirmDiscard(false);
        }}
        title="Discard unsaved changes?"
        description="Your edits will be lost and the form will reset to the saved values."
        confirmLabel="Discard"
        destructive
        onConfirm={confirmDiscardEdits}
      />
    </Dialog>
  );
}
