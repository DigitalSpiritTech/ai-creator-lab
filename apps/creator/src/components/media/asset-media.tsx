/**
 * Renders an asset from the streaming route: an image, a video with its poster, a voice
 * recording, or a transcript's summary with a link to its words.
 * @packageDocumentation
 */
import { assetUrl } from "@/lib/client/api";
import { assetKindInfo } from "@/lib/client/format";
import type { Asset } from "@/lib/client/types";
import { cn } from "@creator-lab/ui/utils";

export function AssetMedia({ asset, className, controls = false }: { asset: Pick<Asset, "id" | "kind" | "mime" | "video" | "audio" | "transcription">; className?: string; controls?: boolean }) {
  if (asset.kind === "audio") return <AudioPlayer asset={asset} className={className} />;
  if (asset.kind === "transcript") return <TranscriptCard asset={asset} className={className} />;
  if (assetKindInfo(asset.kind).playable) {
    return (
      <video
        className={cn("bg-black object-contain", className)}
        src={assetUrl(asset.id)}
        poster={asset.video?.posterPath ? assetUrl(asset.id, { poster: true }) : undefined}
        controls={controls}
        muted={!controls}
        playsInline
        preload="metadata"
      />
    );
  }
  // eslint-disable-next-line @next/next/no-img-element -- local streamed media, not an optimizable remote image
  return <img className={cn("bg-muted object-contain", className)} src={assetUrl(asset.id)} alt={`${asset.kind} ${asset.id.slice(0, 8)}`} loading="lazy" />;
}

/** A take's transcript: how many words over how long, and the words with their times as JSON. */
export function TranscriptCard({ asset, className }: { asset: Pick<Asset, "id" | "transcription">; className?: string }) {
  const info = asset.transcription;
  return (
    <div className={cn("flex flex-col justify-center gap-1 rounded-lg border bg-muted/30 p-2 text-xs", className)}>
      <span className="font-medium">Transcript</span>
      <span className="text-muted-foreground">{info ? `${info.wordCount} words with times over ${info.durationSeconds.toFixed(1)} s${info.language ? ` (${info.language})` : ""}` : "Words with times"}</span>
      <a className="underline underline-offset-2" href={assetUrl(asset.id)} target="_blank" rel="noreferrer">Open the words</a>
    </div>
  );
}

/** A voice recording or voice-over take: the browser's audio controls with its length and words. */
export function AudioPlayer({ asset, className }: { asset: Pick<Asset, "id" | "audio">; className?: string }) {
  const seconds = asset.audio?.durationSeconds;
  return (
    <div className={cn("flex flex-col gap-1 rounded-lg border bg-muted/30 p-2 text-xs", className)}>
      <audio className="w-full" src={assetUrl(asset.id)} controls preload="metadata" aria-label="Voice recording" />
      <div className="flex justify-between gap-2 text-muted-foreground">
        <span className="truncate" title={asset.audio?.transcript}>{asset.audio?.transcript ? `“${asset.audio.transcript}”` : "Voice recording"}</span>
        {seconds ? <span className="shrink-0">{seconds.toFixed(1)} s</span> : null}
      </div>
    </div>
  );
}

/** A thumbnail by id only, for Library references whose record is not loaded. */
export function AssetThumb({ id, className, label }: { id: string | null | undefined; className?: string; label: string }) {
  if (!id) {
    return <div className={cn("flex items-center justify-center rounded-md border border-dashed bg-muted/30 text-xs text-muted-foreground", className)}>{label}: none</div>;
  }
  // eslint-disable-next-line @next/next/no-img-element -- local streamed media
  return <img className={cn("rounded-md bg-muted object-cover", className)} src={assetUrl(id)} alt={label} loading="lazy" />;
}
