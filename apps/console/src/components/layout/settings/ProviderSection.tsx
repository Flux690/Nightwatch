import { useState } from "react";
import { Pencil } from "lucide-react";
import type {
  AgentConfig,
  ModelOption,
  ProviderOption,
  ProviderSettings,
} from "@nightwarden/shared";

import { Button } from "@/components/ui/button";
import {
  Autocomplete,
  AutocompleteContent,
  AutocompleteEmpty,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
} from "@/components/ui/combobox";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { ICON_UI } from "@/lib/iconProps";
import { FIELD_WIDTH } from "./layout";

// The catalog fills one dropdown and nothing else, so its whole state is the
// list plus the line to show when the list is empty. Nothing outside the model
// field waits on it, so nothing outside the model field can be moved by it.
export type CatalogState =
  | { kind: "loading" }
  | { kind: "ready"; models: ModelOption[] }
  | { kind: "empty"; message: string };

interface ProviderSectionProps {
  form: AgentConfig;
  block: ProviderSettings | null;
  // The server's own record for this provider, read live so a key saved a
  // moment ago shows as saved.
  savedApiKeyMasked: string | null;
  catalog: CatalogState;
  providers: ProviderOption[];
  newApiKey: string;
  onProviderChange: (provider: AgentConfig["provider"]) => void;
  onProviderField: <K extends keyof ProviderSettings>(
    key: K,
    value: ProviderSettings[K],
  ) => void;
  onModelChange: (id: string) => void;
  onApiKeyChange: (key: string) => void;
}

export function ProviderSection({
  form,
  block,
  savedApiKeyMasked,
  catalog,
  providers,
  newApiKey,
  onProviderChange,
  onProviderField,
  onModelChange,
  onApiKeyChange,
}: ProviderSectionProps): React.JSX.Element {
  // A stored key is shown masked and replaced deliberately; with none stored
  // there is nothing to replace, so the input is the resting state.
  const [replacingKey, setReplacingKey] = useState(false);
  const keyInputOpen = savedApiKeyMasked === null || replacingKey;
  // The chosen model's ladder travels with the config, so this control is drawn
  // on the first paint from what is already in hand. Nothing here waits on a
  // request, which is why nothing here appears a moment after everything else.
  const reasoning = block?.reasoning ?? null;
  const models = catalog.kind === "ready" ? catalog.models : [];

  return (
    <div className="flex flex-col gap-5">
      <Field className={FIELD_WIDTH.select}>
        <FieldLabel htmlFor="settings-provider">Provider</FieldLabel>
        <NativeSelect
          id="settings-provider"
          className="w-full"
          value={form.provider ?? ""}
          onChange={(e) =>
            onProviderChange(
              (e.currentTarget.value || null) as AgentConfig["provider"],
            )
          }
        >
          {/* A fresh install has picked nothing; the empty option is what
              "not chosen yet" looks like. */}
          <NativeSelectOption value="">Select a provider</NativeSelectOption>
          {providers.map((p) => (
            <NativeSelectOption key={p.name} value={p.name}>
              {p.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>

      <Field className={FIELD_WIDTH.text}>
        <FieldLabel htmlFor="settings-base-url">Base URL</FieldLabel>
        <Input
          id="settings-base-url"
          disabled={block === null}
          placeholder={
            providers.find((p) => p.name === form.provider)?.defaultBaseUrl ??
            ""
          }
          value={block?.baseUrl ?? ""}
          onChange={(e) =>
            onProviderField("baseUrl", e.currentTarget.value || undefined)
          }
        />
      </Field>

      <div className={`flex flex-col gap-2 ${FIELD_WIDTH.text}`}>
        {keyInputOpen ? (
          <Field>
            <FieldLabel htmlFor="settings-api-key">API key</FieldLabel>
            <Input
              id="settings-api-key"
              type="password"
              disabled={block === null}
              placeholder="Paste API key"
              value={newApiKey}
              onChange={(e) => onApiKeyChange(e.currentTarget.value)}
            />
          </Field>
        ) : (
          <Field>
            <FieldLabel htmlFor="settings-api-key-stored">API key</FieldLabel>
            <div className="flex items-center gap-1.5">
              <span
                id="settings-api-key-stored"
                className="font-mono text-sm text-muted-foreground"
              >
                {savedApiKeyMasked}
              </span>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label="Replace API key"
                onClick={() => setReplacingKey(true)}
              >
                <Pencil {...ICON_UI} />
              </Button>
            </div>
          </Field>
        )}
      </div>

      <Field className={FIELD_WIDTH.text}>
        <FieldLabel htmlFor="settings-model">Model</FieldLabel>
        {/* The catalog suggests; it does not decide. Any id is a valid answer,
            so the field's value is the text itself and an unreachable catalog
            never blocks configuring a model. */}
        <Autocomplete
          items={models.map((m) => m.id)}
          value={block?.model ?? ""}
          onValueChange={onModelChange}
          openOnInputClick
        >
          <AutocompleteInput
            id="settings-model"
            aria-label="Model"
            disabled={block === null}
            placeholder={
              block === null ? "Choose a provider first" : "Search models"
            }
          />
          {/* Pinned below: a list that flips lands somewhere different
              depending on how far the panel is scrolled. */}
          <AutocompleteContent
            side="bottom"
            collisionAvoidance={{ side: "none" }}
          >
            {/* Whatever the list has nothing to show is said here, inside the
                popup, so no message ever pushes the form around. */}
            <AutocompleteEmpty>{emptyMessage(catalog)}</AutocompleteEmpty>
            {/* A render function is what makes the list filter: it receives the
                items already matched against the query. Rendering the items
                directly hands back a fixed list that never narrows. */}
            <AutocompleteList>
              {(id: string) => (
                <AutocompleteItem key={id} value={id}>
                  <span className="min-w-0 truncate font-mono">{id}</span>
                </AutocompleteItem>
              )}
            </AutocompleteList>
          </AutocompleteContent>
        </Autocomplete>
      </Field>

      {reasoning && (
        // Rendered from the chosen model's own descriptor: the provider's word
        // arrives in `label`, so nothing here knows which provider is selected.
        <Field className={FIELD_WIDTH.select}>
          <FieldLabel htmlFor="settings-reasoning">
            {reasoning.label}
          </FieldLabel>
          <NativeSelect
            id="settings-reasoning"
            className="w-full"
            value={block?.reasoningLevel ?? ""}
            onChange={(e) =>
              onProviderField("reasoningLevel", e.currentTarget.value || null)
            }
          >
            {reasoning.canDisable && (
              <NativeSelectOption value="">Off</NativeSelectOption>
            )}
            {reasoning.levels.map((l) => (
              <NativeSelectOption key={l.value} value={l.value}>
                {l.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      )}
    </div>
  );
}

// A list with suggestions in it is empty only because the query matched none of
// them; every other reason is one the caller already knows.
function emptyMessage(catalog: CatalogState): string {
  if (catalog.kind === "loading") return "Loading models…";
  if (catalog.kind === "empty") return catalog.message;
  return "No catalog match. The id is used as typed.";
}
