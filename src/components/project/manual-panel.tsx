/**
 * Manual mode: pick a capability, recipe, prompt, reference images, count, and where the results
 * go, then generate through the same gate as the assistant (the proposal card opens in Chat).
 * @packageDocumentation
 */
"use client";

import { Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { useProject } from "@/components/project/project-context";
import { Notice } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { callTool, errorMessage, getJson } from "@/lib/client/api";
import { CAPABILITY_LABELS } from "@/lib/client/format";
import type { GenerationProposal, GenerationTarget, RecipeSummary } from "@/lib/client/types";
import type { Capability } from "@/lib/domain/capability";
import { AssetThumb } from "@/components/media/asset-media";

const CAPABILITIES: Capability[] = ["text_to_image", "image_edit", "image_to_video", "first_last_to_video"];
const ASPECTS = ["9:16", "16:9", "1:1", "4:5", "3:4"] as const;

export function ManualPanel() {
  const { projectId, view, propose } = useProject();
  const [capability, setCapability] = useState<Capability>("text_to_image");
  const [recipes, setRecipes] = useState<RecipeSummary[]>([]);
  const [recipeId, setRecipeId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [references, setReferences] = useState<string[]>([]);
  const [count, setCount] = useState(2);
  const [aspect, setAspect] = useState<(typeof ASPECTS)[number]>("9:16");
  const [targetKey, setTargetKey] = useState("loose");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getJson<{ recipes: RecipeSummary[] }>(`/api/recipes?capability=${capability}`).then(
      ({ recipes: list }) => setRecipes(list),
      () => setRecipes([]),
    );
  }, [capability]);

  const referenceIds = [
    ...view.characters.flatMap(({ item, link }) => [
      item.bible.references.faceAssetId,
      item.bible.references.bodyAssetId,
      link.kind === "character" ? link.sheetAssetId : null,
    ]),
    ...view.products.flatMap((product) => product.imageAssetIds),
    ...view.assets.filter((asset) => asset.kind === "image" || asset.kind === "sheet").map((asset) => asset.id),
  ].filter((id, index, all): id is string => !!id && all.indexOf(id) === index);

  const targets: { key: string; label: string; target: GenerationTarget }[] = [
    { key: "loose", label: "Project assets", target: { kind: "loose" } },
    ...view.characters.flatMap(({ item }) => [
      { key: `${item.id}:face`, label: `${item.bible.name}: face candidates`, target: { kind: "character_reference" as const, characterId: item.id, slot: "face" as const } },
      { key: `${item.id}:body`, label: `${item.bible.name}: body candidates`, target: { kind: "character_reference" as const, characterId: item.id, slot: "body" as const } },
    ]),
  ];

  async function generate(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const proposal = await callTool<GenerationProposal>(
        "propose_candidates",
        {
          projectId,
          capability,
          recipeId: recipeId || undefined,
          prompt: prompt.trim(),
          referenceAssetIds: references,
          count,
          target: (targets.find((entry) => entry.key === targetKey) ?? targets[0]).target,
          aspectRatio: aspect,
        },
        projectId,
      );
      propose(proposal, "manual");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={generate} className="h-full space-y-4 overflow-y-auto p-4 text-sm" aria-label="Manual generation">
      <p className="text-xs text-muted-foreground">Generate without the assistant. The proposal opens in Chat for your approval.</p>
      <label className="block space-y-1">
        <span className="text-xs font-medium">Capability</span>
        <NativeSelect value={capability} onChange={(event) => { setCapability(event.target.value as Capability); setRecipeId(""); }} className="w-full">
          {CAPABILITIES.map((entry) => <NativeSelectOption key={entry} value={entry}>{CAPABILITY_LABELS[entry]}</NativeSelectOption>)}
        </NativeSelect>
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium">Recipe</span>
        <NativeSelect value={recipeId} onChange={(event) => setRecipeId(event.target.value)} className="w-full">
          <NativeSelectOption value="">Default for this capability</NativeSelectOption>
          {recipes.map((recipe) => (
            <NativeSelectOption key={recipe.id} value={recipe.id} disabled={!recipe.available}>
              {recipe.title} · {recipe.costHint}{recipe.verified ? "" : " · unverified"}{recipe.available ? "" : " · needs a key"}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium">Prompt</span>
        <Textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={5} placeholder="3/4 view headshot of Avery Lane, early 30s, light freckles, dark hair tied back, small silver hoops, soft window light" />
      </label>
      {referenceIds.length ? (
        <fieldset className="space-y-1">
          <legend className="text-xs font-medium">References ({references.length} chosen, in order)</legend>
          <div className="grid grid-cols-4 gap-2">
            {referenceIds.map((id) => {
              const position = references.indexOf(id);
              return (
                <label key={id} className={`relative cursor-pointer rounded-md ${position >= 0 ? "ring-2 ring-primary" : ""}`}>
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={position >= 0}
                    onChange={(event) => setReferences((current) => (event.target.checked ? [...current, id] : current.filter((entry) => entry !== id)))}
                  />
                  <AssetThumb id={id} label="Reference" className="aspect-square w-full" />
                  {position >= 0 ? <span className="absolute top-1 left-1 rounded bg-primary px-1 text-[10px] text-primary-foreground">{position + 1}</span> : null}
                </label>
              );
            })}
          </div>
        </fieldset>
      ) : null}
      <div className="grid grid-cols-3 gap-2">
        <label className="space-y-1">
          <span className="text-xs font-medium">Count</span>
          <Input type="number" min={1} max={4} value={count} onChange={(event) => setCount(Math.max(1, Math.min(4, Number(event.target.value) || 1)))} />
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium">Aspect</span>
          <NativeSelect value={aspect} onChange={(event) => setAspect(event.target.value as (typeof ASPECTS)[number])} className="w-full">
            {ASPECTS.map((entry) => <NativeSelectOption key={entry} value={entry}>{entry}</NativeSelectOption>)}
          </NativeSelect>
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium">Results go to</span>
          <NativeSelect value={targetKey} onChange={(event) => setTargetKey(event.target.value)} className="w-full">
            {targets.map((entry) => <NativeSelectOption key={entry.key} value={entry.key}>{entry.label}</NativeSelectOption>)}
          </NativeSelect>
        </label>
      </div>
      {error ? <Notice>{error}</Notice> : null}
      <Button type="submit" disabled={busy || prompt.trim().length === 0}>
        <Sparkles /> Propose generation
      </Button>
    </form>
  );
}
