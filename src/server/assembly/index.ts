/**
 * Assembly: joins a content piece's approved clips in cut order into one 1080 x 1920 ad and
 * saves an immutable export record with its `export` asset. Idempotent by export id: a retry
 * returns the saved record, joins a render already running in this process, or resumes a
 * render that was interrupted before it finished.
 * @packageDocumentation
 */
import { type Asset } from "@/lib/domain/asset";
import {
  type ContentPiece,
  type ExportRecord,
  beginExport,
  completeExport,
  failExport,
  updateCut,
} from "@/lib/domain/content";
import { ServiceError, fail } from "@/lib/domain/failure";
import { preflightRender, renderExport } from "@/server/assembly/render";
import { removeMedia } from "@/server/media/files";
import type { Store } from "@/server/store";

export { captionFilters, escapeDrawtext, layoutCaption, wrapCaption } from "@/server/assembly/captions";
export { planAssembly } from "@/server/assembly/graph";

export interface AssembleInput {
  contentId: string;
  /** Caller-chosen id; repeating it never renders twice. A new id is made when omitted. */
  exportId?: string;
  /** Saved to the content piece's cut before the export is frozen. */
  mute?: boolean;
  captions?: boolean;
}

export interface AssembleContext {
  now(): number;
  newId(): string;
}

export interface AssembleResult {
  export: ExportRecord;
  /** The rendered MP4, when the export completed. */
  asset: Asset | null;
}

const FAILURE_MESSAGE =
  "The export could not be rendered or verified. Check that the approved clips are unchanged on disk, FFmpeg is installed, and there is free disk space. Your clips are safe; export again to retry.";

const running = new Map<string, Promise<AssembleResult>>();

function resultFor(store: Store, record: ExportRecord): AssembleResult {
  const asset = record.status === "completed" ? (store.assets.get(record.assetId) ?? null) : null;
  return { export: record, asset };
}

function withCut(content: ContentPiece, input: AssembleInput, now: number): ContentPiece {
  if (input.mute === undefined && input.captions === undefined) return content;
  const next = updateCut(content, { mute: input.mute, captions: input.captions }, now);
  return next.cut.mute === content.cut.mute && next.cut.captions === content.cut.captions ? content : next;
}

/** Validates the cut and freezes a new rendering record; nothing is saved until tools are ready. */
async function startExport(store: Store, input: AssembleInput, exportId: string, context: AssembleContext): Promise<{ record: ExportRecord; fontPath?: string }> {
  const loadPlan = () => {
    const current = store.content.getRequired(input.contentId);
    const content = withCut(current, input, context.now());
    const script =
      store.scripts.get(content.scriptId, content.scriptVersion) ?? fail("storage", "This content piece's script version is missing.");
    const record = beginExport(exportId, content, script, (id) => store.assets.get(id), context.now());
    return { current, content, record };
  };
  const draft = loadPlan().record;
  const fontPath = await preflightRender({ captions: draft.options.captions, texts: draft.sources.map((source) => source.onScreenText) });
  const record = store.transaction(() => {
    const { current, content, record } = loadPlan();
    if (content !== current) store.content.update(content);
    return store.content.addExport(record);
  });
  return { record, fontPath };
}

async function render(store: Store, record: ExportRecord, context: AssembleContext, fontPath: string | undefined): Promise<AssembleResult> {
  let rendered: Awaited<ReturnType<typeof renderExport>>;
  try {
    rendered = await renderExport(store, record, { now: context.now(), newId: () => context.newId(), fontPath });
  } catch (error) {
    const message = error instanceof ServiceError ? error.message : FAILURE_MESSAGE;
    store.content.finishExport(failExport(record, message, context.now()));
    return resultFor(store, store.content.getExport(record.id)!);
  }
  const completed = completeExport(
    record,
    {
      assetId: rendered.asset.id,
      sha256: rendered.asset.sha256,
      durationSeconds: rendered.durationSeconds,
      filterSummary: rendered.filterSummary,
    },
    context.now(),
  );
  const won = store.transaction(() => {
    if (!store.content.finishExport(completed)) return false;
    store.assets.insert(rendered.asset);
    return true;
  });
  if (!won) await removeMedia(store.dataDir, rendered.files);
  return resultFor(store, store.content.getExport(record.id)!);
}

/**
 * Assembles an ad. Refuses with "invalid" when a shot has no approved clip (naming its beat),
 * and before saving anything when ffmpeg, ffprobe, or (for captions) the font or drawtext are
 * missing. A render that fails is saved as a failed export with a safe message.
 */
export function assembleAd(store: Store, input: AssembleInput, context: AssembleContext): Promise<AssembleResult> {
  const exportId = input.exportId ?? context.newId();
  const existing = store.content.getExport(exportId);
  if (existing) {
    if (existing.contentId !== input.contentId) return Promise.reject(new ServiceError("conflict", "This export id belongs to another content piece."));
    const differs =
      (input.mute !== undefined && input.mute !== existing.options.mute) ||
      (input.captions !== undefined && input.captions !== existing.options.captions);
    if (differs) return Promise.reject(new ServiceError("conflict", "This export id was already used with other options. Export again with a new id."));
    if (existing.status !== "rendering") return Promise.resolve(resultFor(store, existing));
  }
  const key = `${store.dataDir}\n${exportId}`;
  const inFlight = running.get(key);
  if (inFlight) return inFlight;
  const task = (async () => {
    if (existing) {
      const fontPath = await preflightRender({ captions: existing.options.captions, texts: existing.sources.map((source) => source.onScreenText) });
      return render(store, existing, context, fontPath);
    }
    const started = await startExport(store, input, exportId, context);
    if (started.record.status !== "rendering") return resultFor(store, started.record);
    return render(store, started.record, context, started.fontPath);
  })();
  running.set(key, task);
  const forget = () => {
    if (running.get(key) === task) running.delete(key);
  };
  task.then(forget, forget);
  return task;
}
