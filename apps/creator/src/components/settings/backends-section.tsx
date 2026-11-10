/**
 * Settings, Backends: the servers recipes run on (Comfy Cloud, Comfy Router, a self-hosted ComfyUI,
 * a Comfy API deployment), the default for workflows, a free object_info check per backend, and
 * each recipe's status per backend: verified by a real run, compatible by the check, unavailable
 * with the missing nodes and models, or not checked yet.
 * @packageDocumentation
 */
"use client";

import { RefreshCw, Server } from "lucide-react";
import { useCallback, useState } from "react";
import { Notice } from "@/components/shell/page-header";
import { Badge } from "@creator-lab/ui/badge";
import { Button } from "@creator-lab/ui/button";
import { Input } from "@creator-lab/ui/input";
import { NativeSelect, NativeSelectOption } from "@creator-lab/ui/native-select";
import { errorMessage, getJson, sendJson } from "@/lib/client/api";
import { useLoad } from "@/lib/client/use-load";
import { BACKEND_KIND_LABELS, type Backend, type RecipeBackendStatus, describeMissing } from "@creator-lab/core/catalog";

type BackendRow = Backend & { usable: boolean; usableNote: string | null; isDefault: boolean };

interface BackendsView {
  backends: BackendRow[];
  defaultBackendId: string | null;
  recipes: { id: string; title: string; kind: "workflow" | "router" | "mock"; capability: string; statuses: Record<string, RecipeBackendStatus> }[];
  customAllowed: boolean;
}

function probeLine(backend: BackendRow): string {
  const probe = backend.lastProbe;
  if (!probe) return "Not checked yet.";
  const when = new Date(probe.at).toLocaleString();
  if (!probe.ok) return `Checked ${when}: ${probe.error ?? "the check failed."}`;
  const unit = backend.kind === "router" ? "models" : "node classes";
  const missing = Object.keys(probe.missing).length;
  return `Checked ${when}: ${probe.nodeClasses.toLocaleString("en-US")} ${unit}; ${probe.checked.length - missing} of ${probe.checked.length} recipes can run, ${missing} cannot.`;
}

export function StatusCell({ status }: { status: RecipeBackendStatus | undefined }) {
  if (!status || status.status === "not_applicable") return <span className="text-muted-foreground">-</span>;
  if (status.status === "verified") return <span className="text-emerald-700 dark:text-emerald-300">Verified {status.date}</span>;
  if (status.status === "compatible") return <span>Compatible (checked)</span>;
  if (status.status === "unchecked") return <span className="text-muted-foreground" title={status.reason}>Not checked</span>;
  return (
    <span className="text-destructive">
      Unavailable
      <span className="block break-words text-[11px]">{describeMissing(status)}</span>
    </span>
  );
}

export function BackendsSection() {
  const [view, setView] = useState<BackendsView | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [kind, setKind] = useState<"comfyui" | "deployment">("comfyui");
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    try {
      setView(await getJson<BackendsView>("/api/settings/backends"));
    } catch (cause) {
      setMessage({ tone: "error", text: errorMessage(cause) });
    }
  }, []);
  useLoad(load);

  async function act(key: string, work: () => Promise<BackendsView & { added?: Backend; probed?: Backend }>, done?: (next: BackendsView & { added?: Backend; probed?: Backend }) => string) {
    setBusy(key);
    setMessage(null);
    try {
      const next = await work();
      setView(next);
      const text = done?.(next);
      if (text) setMessage({ tone: next.added?.lastProbe?.ok === false || next.probed?.lastProbe?.ok === false ? "error" : "ok", text });
    } catch (cause) {
      setMessage({ tone: "error", text: errorMessage(cause) });
    } finally {
      setBusy(null);
    }
  }

  function add(event: React.FormEvent) {
    event.preventDefault();
    void act(
      "add",
      () => sendJson("/api/settings/backends", { kind, label: label.trim() || BACKEND_KIND_LABELS[kind], baseUrl: url.trim() }),
      (next) => {
        setLabel("");
        setUrl("");
        const probe = next.added?.lastProbe;
        return probe?.ok ? `Added and checked ${next.added?.label}. Make it the default to run workflows there.` : `Added ${next.added?.label}, but the check failed: ${probe?.error ?? "unknown reason"}`;
      },
    );
  }

  if (!view) {
    return (
      <section className="space-y-3" aria-label="Backends">
        <h2 className="flex items-center gap-2 text-sm font-semibold"><Server className="size-4" /> Backends</h2>
        {message ? <Notice>{message.text}</Notice> : <p className="text-xs text-muted-foreground">Loading backends…</p>}
      </section>
    );
  }

  const columns = view.backends;
  const rows = view.recipes.filter((recipe) => showAll || recipe.kind === "workflow");

  return (
    <section className="space-y-3" aria-label="Backends">
      <h2 className="flex items-center gap-2 text-sm font-semibold"><Server className="size-4" /> Backends</h2>
      <p className="text-xs text-muted-foreground">
        Where recipes run. Workflows run on the default backend; when it lacks a recipe&apos;s nodes or models, the proposal says so and runs it on Comfy Cloud instead, or refuses if Cloud cannot run it either. Checking a backend reads its node list (object_info) and costs nothing. Keys are not stored here: Comfy Cloud, Router and Comfy-hosted deployments use the Comfy API key above, and a self-hosted ComfyUI never receives it.
      </p>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      <ul className="space-y-2">
        {columns.map((backend) => (
          <li key={backend.id} className="rounded-lg border p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <span className="font-medium">{backend.label}</span>{" "}
                <span className="text-xs text-muted-foreground">{BACKEND_KIND_LABELS[backend.kind]}</span>{" "}
                {backend.isDefault ? <Badge className="bg-emerald-600 text-white">Default for workflows</Badge> : null}{" "}
                {!backend.usable ? <Badge variant="outline">{backend.usableNote}</Badge> : null}
                <code className="block truncate text-xs text-muted-foreground">{backend.baseUrl}</code>
              </div>
              <div className="flex items-center gap-1">
                <Button size="xs" variant="outline" disabled={!!busy} onClick={() => void act(`probe-${backend.id}`, () => sendJson(`/api/settings/backends/${backend.id}/probe`, {}), (next) => (next.probed?.lastProbe?.ok ? `Checked ${backend.label}.` : `${next.probed?.lastProbe?.error ?? "The check failed."}`))}>
                  <RefreshCw className={busy === `probe-${backend.id}` ? "animate-spin" : undefined} /> Check
                </Button>
                {backend.kind !== "router" && !backend.isDefault ? (
                  <Button size="xs" variant="outline" disabled={!!busy} onClick={() => void act(`default-${backend.id}`, () => sendJson(`/api/settings/backends/${backend.id}`, { default: true }, "PUT"), () => `Workflows now run on ${backend.label}.`)}>
                    Make default
                  </Button>
                ) : null}
                {!backend.builtIn ? (
                  <Button size="xs" variant="ghost" disabled={!!busy} onClick={() => void act(`remove-${backend.id}`, () => sendJson(`/api/settings/backends/${backend.id}`, {}, "DELETE"), () => `Removed ${backend.label}.`)}>
                    Remove
                  </Button>
                ) : null}
              </div>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{probeLine(backend)}</p>
          </li>
        ))}
      </ul>

      {view.customAllowed ? (
        <form onSubmit={add} className="flex flex-wrap items-center gap-2" aria-label="Add a backend">
          <NativeSelect aria-label="Backend kind" value={kind} onChange={(event) => setKind(event.target.value as "comfyui" | "deployment")} className="w-56">
            <NativeSelectOption value="comfyui">{BACKEND_KIND_LABELS.comfyui}</NativeSelectOption>
            <NativeSelectOption value="deployment">{BACKEND_KIND_LABELS.deployment}</NativeSelectOption>
          </NativeSelect>
          <Input aria-label="Backend name" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Name, e.g. Studio PC" className="w-40" />
          <Input aria-label="Backend address" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="http://127.0.0.1:8189" className="w-56" />
          <Button size="sm" type="submit" disabled={!!busy || !url.trim()}>
            {busy === "add" ? "Checking…" : "Add and check"}
          </Button>
        </form>
      ) : (
        <p className="text-xs text-muted-foreground">This is a hosted copy, so only Comfy Cloud and Comfy Router are offered. Add a self-hosted ComfyUI on your own studio.</p>
      )}

      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium">Recipes per backend</h3>
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          <input type="checkbox" checked={showAll} onChange={(event) => setShowAll(event.target.checked)} /> include hosted (Router) recipes
        </label>
      </div>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-left text-xs">
          <thead className="bg-muted/40">
            <tr>
              <th className="p-2 font-medium">Recipe</th>
              {columns.map((backend) => (
                <th key={backend.id} className="p-2 font-medium">{backend.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((recipe) => (
              <tr key={recipe.id} className="border-t align-top">
                <td className="p-2">
                  {recipe.title}
                  <span className="block font-mono text-[11px] text-muted-foreground">{recipe.id}</span>
                </td>
                {columns.map((backend) => (
                  <td key={backend.id} className="max-w-56 p-2">
                    <StatusCell status={recipe.statuses[backend.id]} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
