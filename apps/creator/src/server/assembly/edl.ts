/**
 * The server half of the EDL: reading a transcript file (hash-checked), finding the newest
 * transcript of an Ad's approved take, and drafting the EDL from it. The EDL rules themselves are
 * pure, in `@creator-lab/core/domain/edl`.
 * @packageDocumentation
 */
import type { Asset } from "@creator-lab/core/domain/asset";
import type { ContentPiece } from "@creator-lab/core/domain/content";
import { type Edl, draftEdl } from "@creator-lab/core/domain/edl";
import { fail } from "@creator-lab/core/domain/failure";
import { type Transcript, parseTranscript } from "@creator-lab/core/domain/transcript";
import { readAssetBytes } from "@/server/media/files";
import { sha256 } from "@/server/media/paths";
import type { Store } from "@/server/store";

/** Reads and parses a transcript asset, refusing a file that changed since it was saved. */
export async function readTranscript(store: Store, asset: Asset): Promise<Transcript> {
  if (asset.kind !== "transcript" || asset.state.state === "deleted") fail("invalid", "That asset is not a transcript.");
  const bytes = await readAssetBytes(store.dataDir, asset);
  if (sha256(bytes) !== asset.sha256) fail("storage", "The transcript changed on disk after it was saved.");
  try {
    return parseTranscript(JSON.parse(bytes.toString("utf8")), asset.transcription?.durationSeconds);
  } catch {
    return fail("invalid", "The transcript file could not be read.");
  }
}

/** The newest active transcript made from exactly this take (its id and hash in the provenance). */
export function latestTranscriptFor(store: Store, take: Asset): Asset | undefined {
  if (!take.projectId) return undefined;
  return store.assets
    .list({ projectId: take.projectId, kind: "transcript" })
    .filter(
      (asset) =>
        asset.kind === "transcript" &&
        asset.state.state === "active" &&
        asset.provenance.source === "generated" &&
        asset.provenance.inputs.some((input) => input.assetId === take.id && input.sha256 === take.sha256),
    )
    .sort((a, b) => b.createdAt - a.createdAt)[0];
}

/** The approved take of an Ad, active and a video with sound. */
export function approvedTake(store: Store, content: ContentPiece): Asset {
  if (content.take.state !== "approved") fail("invalid", "Approve a talking recording for this Ad first (generate_take, then approve with kind take).");
  const take = store.assets.get(content.take.assetId);
  if (!take || take.state.state !== "active" || take.kind !== "video" || !take.video) fail("invalid", "The approved recording is missing or archived.");
  return take;
}

/** Drafts the EDL from the newest transcript of the approved take; `unplaced` lists the b-roll beats that got no window. */
export async function draftEdlFor(store: Store, content: ContentPiece): Promise<{ edl: Edl; unplaced: number[]; transcript: Asset }> {
  const take = approvedTake(store, content);
  const transcript = latestTranscriptFor(store, take) ?? fail("invalid", "Transcribe the approved recording first (transcribe_take), then draft the edit decision list.");
  const script = store.scripts.get(content.scriptId, content.scriptVersion) ?? fail("storage", "This Ad's script version is missing.");
  const words = await readTranscript(store, transcript);
  const drafted = draftEdl({
    script,
    take: { assetId: take.id, sha256: take.sha256, durationSeconds: take.video!.durationSeconds },
    transcript: words,
    transcriptAssetId: transcript.id,
  });
  return { ...drafted, transcript };
}
