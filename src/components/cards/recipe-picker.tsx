/**
 * The recipe selector shared by the proposal card and "Regenerate with..." on a candidate: every
 * recipe for the step's capability that can run on the configured backends, as the server lists it
 * (`/api/projects/<id>/recipe-options`). Recipes that cannot take the step's references are shown
 * disabled with the reason. Choosing one never prices or renders anything here; the caller asks the
 * server for the new proposal.
 * @packageDocumentation
 */
"use client";

import { useCallback, useState } from "react";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { errorMessage, getRecipeOptions } from "@/lib/client/api";
import type { RecipeOption, RecipeOptionsView } from "@/lib/client/types";
import { useLoad } from "@/lib/client/use-load";
import { PROMPT_STYLE_LABELS } from "@/lib/catalog/prompt-style";

/** Loads the selector's options once `enabled`; `key` changes reload them. */
export function useRecipeOptions(projectId: string | undefined, query: { capability: string; references: number } | { assetId: string }, enabled: boolean) {
  const [view, setView] = useState<RecipeOptionsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = "assetId" in query ? `asset:${query.assetId}` : `${query.capability}:${query.references}`;
  const load = useCallback(async () => {
    if (!enabled || !projectId) return;
    try {
      setView(await getRecipeOptions(projectId, "assetId" in query ? { assetId: query.assetId } : query));
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    }
    // The query is captured by its key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, projectId, key]);
  useLoad(load);
  return { view, error };
}

/** One option's label: title, cost hint, and what sets it apart. */
export function optionLabel(option: RecipeOption, marks: { preference?: string | null; settingsDefault?: string | null } = {}): string {
  const notes = [
    option.costHint,
    option.verified ? "" : "unverified",
    option.id === marks.preference ? "this project's choice" : option.id === marks.settingsDefault ? "Settings default" : "",
    option.fits ? "" : option.reason ?? "does not fit",
    option.note ?? "",
  ].filter(Boolean);
  return `${option.title}${notes.length ? ` · ${notes.join(" · ")}` : ""}`;
}

export interface RecipePickerProps {
  view: RecipeOptionsView | null;
  value: string;
  /** Shown while the options load, and kept as an entry when the current recipe is not offered. */
  currentTitle: string;
  onChange: (recipeId: string) => void;
  disabled?: boolean;
  label: string;
  /** Leave out the current recipe ("Regenerate with..." picks another one). */
  excludeCurrent?: boolean;
}

export function RecipePicker({ view, value, currentTitle, onChange, disabled, label, excludeCurrent = false }: RecipePickerProps) {
  const options = (view?.options ?? []).filter((option) => !excludeCurrent || option.id !== value);
  const offered = options.some((option) => option.id === value);
  return (
    <NativeSelect size="sm" value={excludeCurrent ? "" : value} onChange={(event) => event.target.value && onChange(event.target.value)} disabled={disabled || !view} aria-label={label} className="w-full max-w-full">
      {excludeCurrent ? <NativeSelectOption value="">Choose a model…</NativeSelectOption> : null}
      {!excludeCurrent && !offered ? <NativeSelectOption value={value}>{currentTitle}</NativeSelectOption> : null}
      {options.map((option) => (
        <NativeSelectOption key={option.id} value={option.id} disabled={!option.fits}>
          {optionLabel(option, view ?? {})}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );
}

/** "Prompt written for Nano Banana (Gemini image)". */
export function styleNote(style: keyof typeof PROMPT_STYLE_LABELS | undefined): string | null {
  return style ? `Written for ${PROMPT_STYLE_LABELS[style]}` : null;
}
