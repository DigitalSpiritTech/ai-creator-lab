/**
 * The Social Post workspace panels: Post (brief, linked Library items, the copy and its history),
 * Stills (one slot per aspect ratio: propose, review, approve), and Export (the approved stills
 * and the copy as text). They read and change the project only through `host.callTool`, the same
 * roster tools the assistant uses, and draw with the shared UI primitives; nothing here imports
 * the app. A proposal a tool returns is shown in the chat panel by the host, where the gate runs it.
 * @packageDocumentation
 */
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Asset } from "@creator-lab/core/domain/asset";
import type { DocumentVersion } from "@creator-lab/core/domain/document";
import type { GenerationTarget, Job } from "@creator-lab/core/domain/job";
import { type PluginPiece, approvedSlots } from "@creator-lab/core/domain/piece";
import type { Brief, Project } from "@creator-lab/core/domain/project";
import type { PanelHost, PanelProps } from "@creator-lab/core/registry";
import { Badge } from "@creator-lab/ui/badge";
import { Button } from "@creator-lab/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@creator-lab/ui/card";
import { Input } from "@creator-lab/ui/input";
import { Textarea } from "@creator-lab/ui/textarea";
import { RATIO_LABELS, SOCIAL_POST_RATIOS, type SocialPostCopy, type SocialPostRatio, SocialPostCopySchema } from "./copy";
import { SOCIAL_POST_PANELS, SOCIAL_POST_PIECE_TYPE, SOCIAL_POST_TOOLS } from "./index";

/** What the panels read from `get_project_state`. */
interface PostState {
  project: Project;
  pieces: PluginPiece[];
  characters: { item: { id: string; bible: { name: string } } }[];
  products: { id: string; name: string }[];
  sets: { id: string; name: string }[];
  assets: Asset[];
  activeJobs: Job[];
}

interface ExportResult {
  title: string;
  copyText: string;
  stills: { aspectRatio: SocialPostRatio; label: string; assetId: string; width: number; height: number }[];
  missing: SocialPostRatio[];
}

const message = (cause: unknown) => (cause instanceof Error ? cause.message : "Something went wrong.");
const aimsAt = (target: GenerationTarget, contentId: string, ratio?: string) => target.kind === "piece" && target.contentId === contentId && (ratio === undefined || target.slot === ratio);

/** Loads the project state through the host and keeps it current. */
function usePostState(host: PanelHost) {
  const [state, setState] = useState<PostState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setState(await host.callTool<PostState>("get_project_state", { projectId: host.projectId }));
      setError(null);
    } catch (cause) {
      setError(message(cause));
    }
  }, [host]);
  useEffect(() => {
    const timer = setTimeout(() => void reload(), 0);
    return () => clearTimeout(timer);
  }, [reload]);
  const post = state?.pieces.find((piece) => piece.type === SOCIAL_POST_PIECE_TYPE);
  const generating = !!post && !!state?.activeJobs.some((job) => aimsAt(job.request.target, post.id));
  // A proposal is approved in the chat panel, outside this panel, so the state is reloaded on a
  // timer too: often while a still for this post is being made, now and then otherwise.
  useEffect(() => {
    const timer = setInterval(() => void reload(), generating ? 3000 : 10_000);
    return () => clearInterval(timer);
  }, [generating, reload]);
  return { state, post, error, reload };
}

function Problem({ text }: { text: string | null }) {
  return text ? <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">{text}</p> : null;
}

function Thumb({ host, assetId, label, className }: { host: PanelHost; assetId: string; label: string; className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element -- local streamed media, not an optimizable remote image
  return <img className={className ?? "max-h-56 w-full rounded-md bg-muted object-contain"} src={host.assetUrl(assetId)} alt={label} loading="lazy" />;
}

const splitTags = (value: string) => value.split(/[\s,]+/).map((tag) => tag.trim()).filter(Boolean);

function BriefCard({ host, project, saved }: { host: PanelHost; project: Project; saved: () => Promise<void> }) {
  const [brief, setBrief] = useState({
    productSummary: project.brief?.productSummary ?? "",
    audience: project.brief?.audience ?? "",
    platforms: project.brief?.platforms.join(", ") ?? "Instagram",
    tone: project.brief?.tone ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setBusy(true);
    try {
      const next: Brief = { ...brief, platforms: brief.platforms.split(",").map((entry) => entry.trim()).filter(Boolean) };
      await host.callTool("save_brief", { projectId: host.projectId, brief: next });
      setError(null);
      await saved();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }
  const field = (key: keyof typeof brief, label: string) => (
    <label className="flex flex-col gap-1 text-xs font-medium">
      {label}
      <Input value={brief[key]} onChange={(event) => setBrief({ ...brief, [key]: event.target.value })} />
    </label>
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Brief</CardTitle>
        <CardDescription>What the post promotes, who it is for, where it runs, and the tone.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {field("productSummary", "What it promotes")}
        {field("audience", "Who it is for")}
        {field("platforms", "Where it runs (comma separated)")}
        {field("tone", "Tone")}
        <Problem text={error} />
        <div>
          <Button size="sm" disabled={busy} onClick={() => void save()}>Save brief</Button>
        </div>
      </CardContent>
    </Card>
  );
}

function CopyCard({ host, post, saved }: { host: PanelHost; post: PluginPiece | undefined; saved: () => Promise<void> }) {
  // A body that no longer parses (an older shape) opens as an empty form instead of crashing the panel.
  const parsed = post ? SocialPostCopySchema.safeParse(post.body) : undefined;
  const current = parsed?.success ? parsed.data : undefined;
  const [copy, setCopy] = useState({
    caption: current?.caption ?? "",
    hashtags: current?.hashtags.map((tag) => `#${tag}`).join(" ") ?? "",
    callToAction: current?.callToAction ?? "",
    visual: current?.visual ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setBusy(true);
    try {
      await host.callTool(SOCIAL_POST_TOOLS.saveCopy, {
        projectId: host.projectId,
        ...(post ? { contentId: post.id, revision: post.revision } : {}),
        copy: { ...copy, hashtags: splitTags(copy.hashtags) },
      });
      setError(null);
      host.notify("ok", post ? "Copy saved as a new version." : "Post started.");
      await saved();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Copy</CardTitle>
        <CardDescription>The caption (hook first), hashtags, call to action, and the visual line the stills are made from.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-xs font-medium">
          Caption <span className="font-normal text-muted-foreground">{copy.caption.length} / 2200</span>
          <Textarea rows={5} value={copy.caption} onChange={(event) => setCopy({ ...copy, caption: event.target.value })} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium">
          Hashtags
          <Input value={copy.hashtags} placeholder="#commute #hydration" onChange={(event) => setCopy({ ...copy, hashtags: event.target.value })} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium">
          Call to action
          <Input value={copy.callToAction} onChange={(event) => setCopy({ ...copy, callToAction: event.target.value })} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium">
          Visual line
          <Textarea rows={2} value={copy.visual} placeholder="The bottle in a car cup holder, morning light through the windshield." onChange={(event) => setCopy({ ...copy, visual: event.target.value })} />
        </label>
        <Problem text={error} />
        <div>
          <Button size="sm" disabled={busy || !copy.caption.trim()} onClick={() => void save()}>{post ? "Save copy" : "Start the post"}</Button>
        </div>
      </CardContent>
    </Card>
  );
}

function HistoryCard({ host, post, restored }: { host: PanelHost; post: PluginPiece; restored: () => Promise<void> }) {
  const [history, setHistory] = useState<{ current: number | null; versions: DocumentVersion[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setHistory(await host.callTool("list_document_versions", { kind: "piece", subjectId: post.id }));
    } catch (cause) {
      setError(message(cause));
    }
  }, [host, post.id]);
  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load, post.revision]);
  async function restore(version: number) {
    try {
      await host.callTool("restore_document_version", { kind: "piece", subjectId: post.id, version });
      host.notify("ok", `Restored version ${version} of the copy.`);
      await restored();
      await load();
    } catch (cause) {
      setError(message(cause));
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Copy history</CardTitle>
        <CardDescription>Every saved version. Restoring one saves it again as the newest.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <Problem text={error} />
        {[...(history?.versions ?? [])].reverse().map((version) => {
          const content = version.kind === "piece" ? SocialPostCopySchema.safeParse(version.content) : undefined;
          return (
            <div key={version.version} className="flex items-start justify-between gap-3 border-b pb-2 text-sm last:border-0">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  Version {version.version}
                  {version.author ? <span>· {version.author}</span> : null}
                  {version.restoredFrom ? <span>· restored {version.restoredFrom}</span> : null}
                  {history?.current === version.version ? <Badge variant="secondary">current</Badge> : null}
                </div>
                <p className="line-clamp-2">{content?.success ? content.data.caption : ""}</p>
              </div>
              {history?.current === version.version ? null : (
                <Button size="sm" variant="ghost" onClick={() => void restore(version.version)}>Restore</Button>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

/** Post: the brief, the linked Library items, the copy, and its history. */
export function PostPanel({ host }: PanelProps) {
  const { state, post, error, reload } = usePostState(host);
  const saved = useCallback(async () => {
    await reload();
    await host.refresh();
  }, [reload, host]);
  if (!state) return <Problem text={error} />;
  const linked = [...state.characters.map(({ item }) => `Character: ${item.bible.name}`), ...state.products.map((product) => `Product: ${product.name}`), ...state.sets.map((set) => `Set: ${set.name}`)];
  return (
    <div className="flex flex-col gap-4">
      <Problem text={error} />
      <BriefCard key={`brief-${state.project.revision}`} host={host} project={state.project} saved={saved} />
      <Card>
        <CardHeader>
          <CardTitle>Library</CardTitle>
          <CardDescription>Linked characters and products are the stills&apos; references. Link them on the Library page or ask the assistant.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {linked.length ? linked.map((entry) => <Badge key={entry} variant="outline">{entry}</Badge>) : <span className="text-sm text-muted-foreground">Nothing linked yet.</span>}
        </CardContent>
      </Card>
      <CopyCard key={`copy-${post?.id ?? "new"}-${post?.revision ?? 0}`} host={host} post={post} saved={saved} />
      {post ? <HistoryCard host={host} post={post} restored={saved} /> : null}
      {post ? (
        <div>
          <Button size="sm" variant="secondary" onClick={() => host.openPanel(SOCIAL_POST_PANELS.stills)}>Go to the stills</Button>
        </div>
      ) : null}
    </div>
  );
}

function RatioCard({ host, post, ratio, state, changed }: { host: PanelHost; post: PluginPiece; ratio: SocialPostRatio; state: PostState; changed: () => Promise<void> }) {
  const slot = post.slots[ratio] ?? { state: "empty" as const };
  const running = state.activeJobs.filter((job) => aimsAt(job.request.target, post.id, ratio)).length;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function act(work: () => Promise<unknown>) {
    setBusy(true);
    try {
      await work();
      setError(null);
      await changed();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }
  const propose = () =>
    act(async () => {
      await host.callTool(SOCIAL_POST_TOOLS.proposeStill, { contentId: post.id, aspectRatio: ratio });
      host.notify("muted", `The ${ratio} proposal is in the chat. Nothing runs until you approve it there.`);
    });
  const approve = (assetId: string) => act(() => host.callTool("approve", { kind: "slot", contentId: post.id, slot: ratio, assetId }));
  const active = new Set(state.assets.map((asset) => asset.id));
  const candidates = slot.state === "empty" ? [] : slot.candidateIds.filter((id) => active.has(id));
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {RATIO_LABELS[ratio]}
          {slot.state === "approved" ? <Badge>approved</Badge> : null}
          {running ? <Badge variant="secondary">{running} generating</Badge> : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {slot.state === "approved" ? <Thumb host={host} assetId={slot.assetId} label={`Approved ${ratio} still`} /> : null}
        {candidates.length && slot.state !== "approved" ? (
          <div className="grid grid-cols-2 gap-2">
            {candidates.map((assetId) => (
              <div key={assetId} className="flex flex-col gap-1">
                <Thumb host={host} assetId={assetId} label={`${ratio} candidate`} className="max-h-40 w-full rounded-md bg-muted object-contain" />
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => void approve(assetId)}>Approve</Button>
              </div>
            ))}
          </div>
        ) : null}
        <Problem text={error} />
        <div>
          <Button size="sm" variant={slot.state === "approved" ? "ghost" : "default"} disabled={busy} onClick={() => void propose()}>
            {slot.state === "empty" ? "Propose stills" : "Propose more"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** Stills: one slot per aspect ratio, each proposed, reviewed, and approved on its own. */
export function StillsPanel({ host }: PanelProps) {
  const { state, post, error, reload } = usePostState(host);
  if (!state) return <Problem text={error} />;
  if (!post) {
    return (
      <div className="flex flex-col items-start gap-3 text-sm text-muted-foreground">
        Save the post&apos;s copy first; its visual line is what the stills are made from.
        <Button size="sm" onClick={() => host.openPanel(SOCIAL_POST_PANELS.post)}>Write the copy</Button>
      </div>
    );
  }
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Problem text={error} />
      {SOCIAL_POST_RATIOS.map((ratio) => (
        <RatioCard key={ratio} host={host} post={post} ratio={ratio} state={state} changed={reload} />
      ))}
    </div>
  );
}

/** Export: the approved stills to download and the copy as text. */
export function ExportPanel({ host }: PanelProps) {
  const { post, state } = usePostState(host);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The export is prepared again only when the post, its revision, or its approved stills change,
  // not on every reload of the project state.
  const postId = post?.id;
  const exportKey = post ? `${post.id}:${post.revision}:${approvedSlots(post).map((entry) => `${entry.slot}=${entry.assetId}`).join(",")}` : "";
  const prepare = useCallback(async () => {
    if (!postId || !exportKey) return;
    try {
      setResult(await host.callTool<ExportResult>(SOCIAL_POST_TOOLS.export, { contentId: postId }));
      setError(null);
    } catch (cause) {
      setResult(null);
      setError(message(cause));
    }
  }, [host, postId, exportKey]);
  useEffect(() => {
    const timer = setTimeout(() => void prepare(), 0);
    return () => clearTimeout(timer);
  }, [prepare]);
  const textHref = useMemo(() => (result ? `data:text/plain;charset=utf-8,${encodeURIComponent(result.copyText)}` : undefined), [result]);
  if (!state) return null;
  if (!post) return <p className="text-sm text-muted-foreground">Nothing to export yet. Write the copy and approve a still first.</p>;
  return (
    <div className="flex flex-col gap-4">
      <Problem text={error} />
      {result ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Copy</CardTitle>
              <CardDescription>Paste this into the post.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <Textarea readOnly rows={8} value={result.copyText} />
              <div className="flex gap-2">
                <Button size="sm" onClick={() => void navigator.clipboard?.writeText(result.copyText).then(() => host.notify("ok", "Copy copied."))}>Copy text</Button>
                <Button size="sm" variant="secondary" asChild>
                  <a href={textHref} download={`${result.title.replace(/[^\w-]+/g, "-").slice(0, 60) || "post"}.txt`}>Download as text</a>
                </Button>
              </div>
            </CardContent>
          </Card>
          <div className="grid gap-4 xl:grid-cols-2">
            {result.stills.map((still) => (
              <Card key={still.aspectRatio}>
                <CardHeader>
                  <CardTitle>{still.label}</CardTitle>
                  <CardDescription>{still.width} x {still.height}</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-2">
                  <Thumb host={host} assetId={still.assetId} label={`${still.aspectRatio} still`} />
                  <Button size="sm" variant="secondary" asChild>
                    <a href={host.assetUrl(still.assetId, { download: true })}>Download</a>
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
          {result.missing.length ? <p className="text-sm text-muted-foreground">No approved still yet for {result.missing.join(", ")}.</p> : null}
        </>
      ) : null}
      <div>
        <Button size="sm" variant="ghost" onClick={() => void prepare()}>Refresh</Button>
      </div>
    </div>
  );
}

/** The panel components, keyed by panel id, for the app to register. */
export const SOCIAL_POST_PANEL_COMPONENTS = {
  [SOCIAL_POST_PANELS.post]: PostPanel,
  [SOCIAL_POST_PANELS.stills]: StillsPanel,
  [SOCIAL_POST_PANELS.export]: ExportPanel,
};

export type { SocialPostCopy };
