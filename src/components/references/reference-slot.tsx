/**
 * A locked face or body reference, generated or uploaded, with "Use a photo" beside it. Photos of
 * any shape fill the slot with object-fit cover aligned to the top, where the face usually is.
 * @packageDocumentation
 */
"use client";

import { AssetThumb } from "@/components/media/asset-media";
import { PhotoUpload } from "@/components/references/photo-upload";
import { lockPhotoAsReference } from "@/lib/client/references";
import { cn } from "@/lib/utils";

export const REFERENCE_FIT = "object-cover object-top";

export function ReferenceSlot({
  slot,
  assetId,
  characterId,
  projectId,
  className,
  onLocked,
  onError,
  canUpload = true,
}: {
  slot: "face" | "body";
  assetId: string | null;
  characterId: string;
  projectId?: string | null;
  className?: string;
  onLocked: () => Promise<void> | void;
  onError: (message: string) => void;
  /** The body can be locked only after the face. */
  canUpload?: boolean;
}) {
  const label = slot === "face" ? "Face" : "Body";
  return (
    <div className="space-y-1.5" data-testid={`reference-slot-${slot}`}>
      <AssetThumb id={assetId} label={label} className={cn(REFERENCE_FIT, className)} />
      <PhotoUpload
        label="Use a photo"
        requireLikenessConsent
        disabled={!canUpload}
        onFiles={async ([file]) => {
          try {
            await lockPhotoAsReference(file, { characterId, slot, projectId });
            await onLocked();
          } catch (cause) {
            onError(cause instanceof Error ? cause.message : "The photo could not be used.");
          }
        }}
      />
    </div>
  );
}
