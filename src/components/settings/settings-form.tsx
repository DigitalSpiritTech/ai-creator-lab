/**
 * Settings: keys (write-only; the page only ever learns whether each is set), assistant model,
 * backends (where recipes run, with a free object_info check), monthly budget (reset day, add to this month, the read-only operator ceiling) and auto-approve,
 * default recipe per capability, data directory, theme.
 * @packageDocumentation
 */
"use client";

import { KeyRound, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { BackendsSection } from "@/components/settings/backends-section";
import { Notice, PageHeader } from "@/components/shell/page-header";
import { ThemeToggle } from "@/components/theme-toggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { useLoad } from "@/lib/client/use-load";
import { errorMessage, extendBudget, getJson, sendJson } from "@/lib/client/api";
import { CAPABILITY_LABELS, describeSpendWarning, formatPeriodDate, formatUsd, formatUsdCredits } from "@/lib/client/format";
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

  const [tools, setTools] = useState<VideoToolsView | null>(null);
  const [checkingTools, setCheckingTools] = useState(false);
  const checkTools = useCallback(async () => {
    setCheckingTools(true);
    try {
      setTools(await getJson<VideoToolsView>("/api/settings/tools"));
    } catch (cause) {
      setTools({ ffmpeg: { path: "ffmpeg", version: null }, ffprobe: { path: "ffprobe", version: null }, captions: false, source: "path", message: errorMessage(cause), checkedAt: Date.now() });
    } finally {
      setCheckingTools(false);
    }
  }, []);
  useLoad(checkTools);

  const load = useCallback(async () => {
    try {
      const next = await getJson<SettingsView>("/api/settings");
      setView(next);
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

  async function saveProvider(llmProvider: string) {
    setBusy(true);
    setMessage(null);
    try {
      await sendJson("/api/settings/keys", { llmProvider });
      setMessage({ tone: "ok", text: llmProvider === "router" ? "The assistant now runs through Comfy Router on your Comfy credits." : "The assistant now uses your Anthropic key directly." });
      await load();
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
        <ProviderChoice
          value={view.keys.llmProvider?.value ?? "anthropic"}
          fromEnvironment={view.keys.llmProvider?.source === "environment"}
          disabled={busy}
          onChange={(value) => void saveProvider(value)}
        />
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

      <BackendsSection />

      <MonthlyBudget
        view={view}
        busy={busy}
        onSave={(patch) => void saveWorkspace(patch)}
        onExtended={(next) => {
          setView(next);
          setMessage({ tone: "ok", text: "Added to this month. Next month starts from your monthly budget again." });
        }}
        onError={(text) => setMessage({ tone: "error", text })}
      />

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

      <RouterModels
        enabled={view.workspace.routerModels}
        disabled={busy}
        onChange={(routerModels) => {
          void saveWorkspace({ routerModels }).then(() => getJson<{ recipes: RecipeSummary[] }>("/api/recipes").then(({ recipes: list }) => setRecipes(list), () => undefined));
        }}
      />

      <section className="space-y-3 text-sm" aria-label="Video tools">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Video tools</h2>
          <Button size="sm" variant="outline" disabled={checkingTools} onClick={() => void checkTools()}>
            <RefreshCw className={checkingTools ? "animate-spin" : undefined} /> Recheck
          </Button>
        </div>
        {tools ? (
          <>
            <Notice tone={tools.captions ? "ok" : tools.ffmpeg.version && tools.ffprobe.version ? "warn" : "error"}>{tools.message}</Notice>
            <div className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-2">
              <Stat label={`ffmpeg${tools.ffmpeg.version ? ` ${tools.ffmpeg.version}` : ""}`} value={tools.ffmpeg.path} />
              <Stat label={`ffprobe${tools.ffprobe.version ? ` ${tools.ffprobe.version}` : ""}`} value={tools.ffprobe.path} />
            </div>
            <p className="text-xs text-muted-foreground">
              {tools.source === "environment"
                ? "From FFMPEG_PATH and FFPROBE_PATH in .env.local."
                : tools.source === "homebrew-full"
                  ? "Homebrew's ffmpeg-full, found automatically. Set FFMPEG_PATH and FFPROBE_PATH in .env.local to use another."
                  : "The first ffmpeg and ffprobe on PATH. Set FFMPEG_PATH and FFPROBE_PATH in .env.local to use another."}
            </p>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">Checking…</p>
        )}
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

/**
 * The spend policy in Settings: this period's numbers, the monthly budget and reset day, "add to
 * this month", and the operator ceiling (GENERATION_ALLOWANCE_USD), which is read-only here.
 */
export function MonthlyBudget({
  view,
  busy,
  onSave,
  onExtended,
  onError,
}: {
  view: SettingsView;
  busy: boolean;
  onSave: (patch: Record<string, unknown>) => void;
  onExtended: (next: SettingsView) => void;
  onError: (text: string) => void;
}) {
  const { spend, workspace, creditsPerUsd } = view;
  const [budget, setBudget] = useState(String(workspace.monthlyBudgetUsd));
  const [resetDay, setResetDay] = useState(String(workspace.budgetResetDay));
  const [extra, setExtra] = useState("");
  const [extending, setExtending] = useState(false);
  const warning = describeSpendWarning(spend.warning, spend.period.endsAt);
  const usd = (value: number) => formatUsdCredits(value, creditsPerUsd);
  const extraValue = Number(extra);
  const canExtend = spend.ceilingUsd > 0 && spend.maxExtensionUsd > 0;

  async function extend(event: React.FormEvent) {
    event.preventDefault();
    if (!(Number.isFinite(extraValue) && extraValue > 0)) return;
    setExtending(true);
    try {
      onExtended(await extendBudget({ id: crypto.randomUUID(), periodKey: spend.period.key, amountUsd: extraValue }));
      setExtra("");
    } catch (cause) {
      onError(errorMessage(cause));
    } finally {
      setExtending(false);
    }
  }

  return (
    <section className="space-y-3" aria-label="Monthly budget">
      <h2 className="text-sm font-semibold">Monthly budget</h2>
      <p className="text-xs text-muted-foreground">
        This period runs from {formatPeriodDate(spend.period.startsAt)} to {formatPeriodDate(spend.period.endsAt)} (UTC).
      </p>
      <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
        <Stat label="This month's budget" value={formatUsd(spend.effectiveLimitUsd)} />
        <Stat label="Spent" value={formatUsd(spend.spentUsd)} />
        <Stat label="Reserved" value={formatUsd(spend.reservedUsd)} />
        <Stat label="Remaining" value={formatUsd(spend.remainingUsd)} />
      </div>
      <p className="text-xs text-muted-foreground">
        Remaining {usd(spend.remainingUsd)}.
        {spend.extensionUsd > 0 ? ` Includes ${formatUsd(spend.extensionUsd)} added to this month.` : ""}
      </p>
      {warning ? <Notice tone={warning.tone}>{warning.text}</Notice> : null}
      <div className="rounded-lg border p-2 text-xs" aria-label="Operator ceiling">
        <div className="text-muted-foreground">Operator ceiling (GENERATION_ALLOWANCE_USD, read-only)</div>
        <div className="text-base font-semibold">{formatUsd(spend.ceilingUsd)} a month</div>
        <p className="mt-1 text-muted-foreground">
          {spend.ceilingUsd > 0
            ? `No month can spend more than this, whatever the budget or extensions; ${formatUsd(spend.ceilingSpentUsd)} of it is spent this calendar month. Only the person running this install can change it.`
            : "Zero keeps paid generation off on this install. Only the person running this install can change it."}
        </p>
      </div>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const value = Number(budget);
          const day = Number(resetDay);
          if (Number.isFinite(value) && value >= 0 && Number.isInteger(day) && day >= 1 && day <= 28) onSave({ monthlyBudgetUsd: value, budgetResetDay: day });
        }}
      >
        <label htmlFor="monthly-budget" className="text-sm">Monthly budget (USD)</label>
        <Input id="monthly-budget" type="number" min={0} max={10000} step={0.5} value={budget} onChange={(event) => setBudget(event.target.value)} className="w-28" />
        <label htmlFor="budget-reset-day" className="text-sm">Resets on day</label>
        <NativeSelect id="budget-reset-day" aria-describedby="budget-reset-note" value={resetDay} onChange={(event) => setResetDay(event.target.value)} className="w-20">
          {Array.from({ length: 28 }, (_, index) => String(index + 1)).map((day) => (
            <NativeSelectOption key={day} value={day}>{day}</NativeSelectOption>
          ))}
        </NativeSelect>
        <Button size="sm" type="submit" disabled={busy}>Save</Button>
        <p className="w-full text-xs text-muted-foreground" id="budget-reset-note">
          Changing the reset day starts a new budget period now: spend and anything added to this month before the new start no longer count against it. The operator ceiling still counts the whole calendar month.
        </p>
      </form>
      <form className="flex flex-wrap items-center gap-2" onSubmit={(event) => void extend(event)}>
        <label htmlFor="budget-extra" className="text-sm">Add to this month (USD)</label>
        <Input
          id="budget-extra"
          type="number"
          min={0.01}
          max={spend.maxExtensionUsd}
          step={0.5}
          value={extra}
          disabled={!canExtend}
          onChange={(event) => setExtra(event.target.value)}
          className="w-28"
        />
        <Button size="sm" type="submit" variant="outline" disabled={!canExtend || extending || !(extraValue > 0)}>Add</Button>
        <span className="text-xs text-muted-foreground">
          {canExtend ? `Up to ${formatUsd(spend.maxExtensionUsd)} under the operator ceiling. This month only.` : "The operator ceiling leaves no room to add more this month."}
        </span>
      </form>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={workspace.autoApprove} disabled={busy} onChange={(event) => onSave({ autoApprove: event.target.checked })} />
        Auto-approve proposals under this month&apos;s budget (skip the Approve and generate step)
      </label>
    </section>
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

export const ASSISTANT_PROVIDERS = [
  { value: "anthropic", label: "Anthropic key (direct)", hint: "Uses the Anthropic API key above." },
  { value: "router", label: "Comfy Router (uses your Comfy credits, no Anthropic key)", hint: "Uses the Comfy API key above; assistant turns draw from the same credits as generation." },
] as const;

export function ProviderChoice({ value, fromEnvironment, disabled, onChange }: { value: string; fromEnvironment: boolean; disabled: boolean; onChange: (value: string) => void }) {
  return (
    <fieldset className="space-y-1.5 rounded-lg border p-3 text-sm" disabled={disabled || fromEnvironment}>
      <legend className="px-1 text-xs font-medium">Assistant provider</legend>
      {ASSISTANT_PROVIDERS.map((provider) => (
        <label key={provider.value} className="flex items-start gap-2">
          <input type="radio" name="assistant-provider" value={provider.value} checked={value === provider.value} onChange={() => onChange(provider.value)} className="mt-1" />
          <span>
            {provider.label}
            <span className="block text-xs text-muted-foreground">{provider.hint}</span>
          </span>
        </label>
      ))}
      {fromEnvironment ? <p className="text-xs text-muted-foreground">Set by LLM_PROVIDER in .env.local.</p> : null}
    </fieldset>
  );
}

interface VideoToolsView {
  ffmpeg: { path: string; version: string | null };
  ffprobe: { path: string; version: string | null };
  captions: boolean;
  source: "environment" | "homebrew-full" | "path";
  message: string;
  checkedAt: number;
}

interface RouterModelRow {
  id: string;
  provider: string;
  model: string;
  family: string | null;
  capabilities: string[];
  supported: boolean;
  enabled: boolean;
  note: string | null;
}

/**
 * Every model Comfy Router offers. Models whose provider family the app has an adapter for can be
 * switched on; each then appears in the recipe pickers for the capabilities it covers. The rest are
 * listed so the catalog is visible, with the capabilities read from their schemas when known.
 */
function RouterModels({ enabled, disabled, onChange }: { enabled: string[]; disabled: boolean; onChange: (models: string[]) => void }) {
  const [rows, setRows] = useState<RouterModelRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [showUnsupported, setShowUnsupported] = useState(false);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const { models } = await getJson<{ models: RouterModelRow[] }>(`/api/router/models${refresh ? "?refresh=1" : ""}`);
      setRows(models);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, []);
  const initial = useCallback(() => load(), [load]);
  useLoad(initial);

  const on = new Set(enabled);
  const visible = (rows ?? []).filter((row) => (showUnsupported || row.supported) && (!filter || row.id.toLowerCase().includes(filter.toLowerCase())));
  const families = new Map<string, RouterModelRow[]>();
  for (const row of visible) {
    const key = row.family ?? `${row.provider} (no adapter yet)`;
    families.set(key, [...(families.get(key) ?? []), row]);
  }
  const supportedCount = (rows ?? []).filter((row) => row.supported).length;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Comfy Router models</h2>
        <div className="flex items-center gap-2">
          <Input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter by name" className="h-7 w-44 text-xs" aria-label="Filter Router models" />
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            <input type="checkbox" checked={showUnsupported} onChange={(event) => setShowUnsupported(event.target.checked)} /> show models without an adapter
          </label>
          <Button size="sm" variant="outline" disabled={loading} onClick={() => void load(true)}>
            <RefreshCw className={loading ? "animate-spin" : undefined} /> Refresh list
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {rows ? `${rows.length} models on Router, ${supportedCount} with an adapter. ` : ""}
        Switch a model on and it joins the recipe pickers for the capabilities its adapter covers; the price is reserved at the adapter&apos;s ceiling until Router can quote it. The starter recipes stay regardless.
      </p>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {rows === null && !error ? <p className="text-xs text-muted-foreground">Loading the model list…</p> : null}
      {[...families.entries()].map(([family, list]) => (
        <div key={family} className="rounded-lg border p-3">
          <h3 className="mb-2 text-xs font-medium">{family}</h3>
          <ul className="grid gap-1 text-xs sm:grid-cols-2">
            {list.map((row) => (
              <li key={row.id} className="flex items-start gap-2">
                <input
                  type="checkbox"
                  id={`router-${row.id}`}
                  disabled={disabled || !row.supported}
                  checked={on.has(row.id)}
                  onChange={(event) => {
                    const next = new Set(on);
                    if (event.target.checked) next.add(row.id);
                    else next.delete(row.id);
                    onChange([...next].sort());
                  }}
                  className="mt-0.5"
                />
                <label htmlFor={`router-${row.id}`} className="min-w-0">
                  <span className="font-mono">{row.id}</span>
                  <span className="block text-muted-foreground">
                    {row.capabilities.length ? row.capabilities.map((capability) => CAPABILITY_LABELS[capability as Capability] ?? capability).join(", ") : "capabilities unknown"}
                    {row.note ? ` · ${row.note}` : ""}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
