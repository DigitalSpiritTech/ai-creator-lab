/**
 * Settings: keys (write-only; the page only ever learns whether each is set), assistant model,
 * generation allowance and auto-approve, default recipe per capability, data directory, theme.
 * @packageDocumentation
 */
"use client";

import { KeyRound, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Notice, PageHeader } from "@/components/shell/page-header";
import { ThemeToggle } from "@/components/theme-toggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { useLoad } from "@/lib/client/use-load";
import { errorMessage, getJson, sendJson } from "@/lib/client/api";
import { CAPABILITY_LABELS, formatUsd } from "@/lib/client/format";
import type { ConnectionView, RecipeSummary, SettingsView } from "@/lib/client/types";
import type { Capability } from "@/lib/domain/capability";

const DEFAULT_CAPABILITIES: Capability[] = ["text_to_image", "image_edit", "image_to_video", "first_last_to_video"];

function KeyStatus({ present, source }: { present: boolean; source: string | null }) {
  return present ? (
    <Badge className="bg-emerald-600 text-white">Set{source === "environment" ? " in .env.local" : " in Settings"}</Badge>
  ) : (
    <Badge variant="outline">Not set</Badge>
  );
}

export function SettingsForm() {
  const [view, setView] = useState<SettingsView | null>(null);
  const [recipes, setRecipes] = useState<RecipeSummary[]>([]);
  const [comfyKey, setComfyKey] = useState("");
  const [anthropicKey, setAnthropicKey] = useState("");
  const [model, setModel] = useState("");
  const [allowance, setAllowance] = useState("");
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [connection, setConnection] = useState<ConnectionView | null>(null);
  const [checking, setChecking] = useState(false);

  const checkConnection = useCallback(async () => {
    setChecking(true);
    try {
      setConnection(await getJson<ConnectionView>("/api/settings/connection"));
    } catch (cause) {
      setConnection({ configured: true, ok: false, status: null, credits: null, cloudCredits: null, prepaidCredits: null, message: errorMessage(cause), checkedAt: Date.now() });
    } finally {
      setChecking(false);
    }
  }, []);
  useLoad(checkConnection);

  const load = useCallback(async () => {
    try {
      const next = await getJson<SettingsView>("/api/settings");
      setView(next);
      setAllowance(String(next.workspace.allowanceUsd));
      setModel(next.keys.llmModel.source === "settings" ? (next.keys.llmModel.value ?? "") : "");
    } catch (cause) {
      setMessage({ tone: "error", text: errorMessage(cause) });
    }
  }, []);

  useLoad(load);
  useEffect(() => {
    getJson<{ recipes: RecipeSummary[] }>("/api/recipes").then(({ recipes: list }) => setRecipes(list), () => setRecipes([]));
  }, []);

  async function saveKeys(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const patch: Record<string, string> = {};
      if (comfyKey.trim()) patch.comfyApiKey = comfyKey.trim();
      if (anthropicKey.trim()) patch.anthropicApiKey = anthropicKey.trim();
      if (view && model.trim() !== (view.keys.llmModel.source === "settings" ? (view.keys.llmModel.value ?? "") : "")) patch.llmModel = model.trim();
      await sendJson("/api/settings/keys", patch);
      setComfyKey("");
      setAnthropicKey("");
      setMessage({ tone: "ok", text: "Saved. Keys stay on this computer and are never shown again." });
      await load();
      await checkConnection();
    } catch (cause) {
      setMessage({ tone: "error", text: errorMessage(cause) });
    } finally {
      setBusy(false);
    }
  }

  async function clearKey(name: "comfyApiKey" | "anthropicApiKey") {
    setBusy(true);
    try {
      await sendJson("/api/settings/keys", { [name]: null });
      await load();
    } catch (cause) {
      setMessage({ tone: "error", text: errorMessage(cause) });
    } finally {
      setBusy(false);
    }
  }

  async function saveWorkspace(patch: Record<string, unknown>) {
    if (!view) return;
    setBusy(true);
    setMessage(null);
    try {
      setView(await sendJson<SettingsView>("/api/settings", { ...patch, revision: view.workspace.revision }, "PUT"));
      setMessage({ tone: "ok", text: "Settings saved." });
    } catch (cause) {
      setMessage({ tone: "error", text: errorMessage(cause) });
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (!view) return <div className="p-8">{message ? <Notice>{message.text}</Notice> : <p className="text-sm text-muted-foreground">Loading settings…</p>}</div>;

  return (
    <div className="mx-auto max-w-3xl space-y-8 p-8">
      <PageHeader title="Settings" description="Keys, spending, and defaults for this workspace." />
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}

      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold"><KeyRound className="size-4" /> Keys</h2>
        <p className="text-xs text-muted-foreground">
          Keys are saved on this computer only and sent to the server once. The page never shows them again. Values in .env.local take precedence.
        </p>
        <form onSubmit={saveKeys} className="space-y-3" autoComplete="off">
          <div className="grid grid-cols-[10rem_1fr_auto] items-center gap-2 text-sm">
            <label htmlFor="comfy-key">Comfy API key</label>
            <Input id="comfy-key" type="password" value={comfyKey} onChange={(event) => setComfyKey(event.target.value)} placeholder={view.keys.comfyApiKey.present ? "•••••••• (set)" : "Paste your Comfy API key"} autoComplete="off" />
            <div className="flex items-center gap-1">
              <KeyStatus {...view.keys.comfyApiKey} />
              {view.keys.comfyApiKey.source === "settings" ? <Button type="button" size="xs" variant="ghost" onClick={() => void clearKey("comfyApiKey")}>Remove</Button> : null}
            </div>
            <label htmlFor="anthropic-key">Anthropic API key</label>
            <Input id="anthropic-key" type="password" value={anthropicKey} onChange={(event) => setAnthropicKey(event.target.value)} placeholder={view.keys.anthropicApiKey.present ? "•••••••• (set)" : "Paste your Anthropic API key"} autoComplete="off" />
            <div className="flex items-center gap-1">
              <KeyStatus {...view.keys.anthropicApiKey} />
              {view.keys.anthropicApiKey.source === "settings" ? <Button type="button" size="xs" variant="ghost" onClick={() => void clearKey("anthropicApiKey")}>Remove</Button> : null}
            </div>
            <label htmlFor="llm-model">Assistant model</label>
            <Input id="llm-model" value={model} onChange={(event) => setModel(event.target.value)} placeholder={view.keys.llmModel.value ?? "claude-opus-5-5"} disabled={view.keys.llmModel.source === "environment"} />
            <span className="text-xs text-muted-foreground">{view.keys.llmModel.source === "environment" ? "From .env.local" : ""}</span>
          </div>
          <Button type="submit" size="sm" disabled={busy}>Save keys</Button>
        </form>
      </section>

      <section className="space-y-3" aria-label="Comfy connection">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Comfy connection</h2>
          <Button size="sm" variant="outline" disabled={checking} onClick={() => void checkConnection()}>
            <RefreshCw className={checking ? "animate-spin" : undefined} /> Refresh
          </Button>
        </div>
        {connection ? (
          <>
            <Notice tone={connection.ok ? "ok" : connection.configured ? "error" : "muted"}>{connection.message}</Notice>
            {connection.ok ? (
              <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
                <Stat label="Account" value={connection.status ?? "Unknown"} />
                <Stat label="Credits" value={(connection.credits ?? 0).toLocaleString("en-US")} />
                <Stat label="Plan credits" value={connection.cloudCredits === null ? "n/a" : connection.cloudCredits.toLocaleString("en-US")} />
                <Stat label="Prepaid credits" value={connection.prepaidCredits === null ? "n/a" : connection.prepaidCredits.toLocaleString("en-US")} />
              </div>
            ) : null}
          </>
        ) : (
          <p className="text-xs text-muted-foreground">Checking…</p>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Generation allowance</h2>
        <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
          <Stat label="In force" value={formatUsd(view.allowance.effectiveUsd)} />
          <Stat label="Spent" value={formatUsd(view.allowance.spentUsd)} />
          <Stat label="Reserved" value={formatUsd(view.allowance.reservedUsd)} />
          <Stat label="Operator cap (.env.local)" value={formatUsd(view.allowance.operatorUsd)} />
        </div>
        <p className="text-xs text-muted-foreground">
          Paid runs stop at the lower of your allowance and the operator cap. A cap of zero keeps paid generation off; mock recipes still run.
        </p>
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const value = Number(allowance);
            if (Number.isFinite(value) && value >= 0) void saveWorkspace({ allowanceUsd: value });
          }}
        >
          <label htmlFor="allowance" className="text-sm">Your allowance (USD)</label>
          <Input id="allowance" type="number" min={0} max={10000} step={0.5} value={allowance} onChange={(event) => setAllowance(event.target.value)} className="w-28" />
          <Button size="sm" type="submit" disabled={busy}>Save</Button>
        </form>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={view.workspace.autoApprove} disabled={busy} onChange={(event) => void saveWorkspace({ autoApprove: event.target.checked })} />
          Auto-approve proposals under the allowance (skip the Approve and generate step)
        </label>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Default recipe per capability</h2>
        <div className="grid grid-cols-[14rem_1fr] items-center gap-2 text-sm">
          {DEFAULT_CAPABILITIES.map((capability) => (
            <DefaultRecipe
              key={capability}
              capability={capability}
              value={view.workspace.defaultRecipes[capability] ?? ""}
              recipes={recipes.filter((recipe) => recipe.capability === capability)}
              disabled={busy}
              onChange={(recipeId) => {
                const next = { ...view.workspace.defaultRecipes };
                if (recipeId) next[capability] = recipeId;
                else delete next[capability];
                void saveWorkspace({ defaultRecipes: next });
              }}
            />
          ))}
        </div>
      </section>

      <section className="space-y-2 text-sm">
        <h2 className="text-sm font-semibold">Data directory</h2>
        <code className="block rounded-md bg-muted px-2 py-1 text-xs">{view.dataDirectory}</code>
        <p className="text-xs text-muted-foreground">Set STUDIO_DATA_DIR in .env.local and restart to move it.</p>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Theme</h2>
        <ThemeToggle />
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-2">
      <div className="text-muted-foreground">{label}</div>
      <div className="text-base font-semibold">{value}</div>
    </div>
  );
}

function DefaultRecipe({ capability, value, recipes, disabled, onChange }: { capability: Capability; value: string; recipes: RecipeSummary[]; disabled: boolean; onChange: (recipeId: string) => void }) {
  return (
    <>
      <label htmlFor={`default-${capability}`}>{CAPABILITY_LABELS[capability]}</label>
      <NativeSelect id={`default-${capability}`} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} className="w-full">
        <NativeSelectOption value="">Starter default</NativeSelectOption>
        {recipes.map((recipe) => (
          <NativeSelectOption key={recipe.id} value={recipe.id}>
            {recipe.title} · {recipe.costHint}{recipe.verified ? "" : " · unverified"}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </>
  );
}
