/**
 * A file picker styled as a button that hands one or more images to `onFiles`. With
 * `requireLikenessConsent`, the likeness checkbox must be checked before the button enables.
 * @packageDocumentation
 */
"use client";

import { ImageUp, Loader2 } from "lucide-react";
import { useId, useState } from "react";
import { LikenessConsent } from "@/components/references/likeness-consent";
import { UPLOAD_TYPES } from "@/lib/client/api";
import { cn } from "@/lib/utils";

export interface PhotoUploadProps {
  label: string;
  onFiles: (files: File[]) => Promise<void>;
  multiple?: boolean;
  requireLikenessConsent?: boolean;
  disabled?: boolean;
  className?: string;
}

export function PhotoUpload({ label, onFiles, multiple = false, requireLikenessConsent = false, disabled = false, className }: PhotoUploadProps) {
  const id = useId();
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const enabled = !disabled && !busy && (!requireLikenessConsent || consent);

  async function pick(list: FileList | null) {
    const files = [...(list ?? [])];
    if (!files.length) return;
    setBusy(true);
    try {
      await onFiles(multiple ? files : files.slice(0, 1));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={cn("space-y-1", className)}>
      <label
        htmlFor={`${id}-file`}
        aria-disabled={!enabled}
        className={cn(
          "inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs font-medium",
          enabled ? "cursor-pointer hover:bg-muted" : "cursor-not-allowed opacity-50",
        )}
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <ImageUp className="size-3.5" aria-hidden />}
        {label}
      </label>
      <input
        id={`${id}-file`}
        type="file"
        accept={UPLOAD_TYPES}
        multiple={multiple}
        disabled={!enabled}
        className="sr-only"
        onChange={(event) => {
          void pick(event.target.files);
          event.target.value = "";
        }}
      />
      {requireLikenessConsent ? <LikenessConsent id={`${id}-consent`} checked={consent} onChange={setConsent} /> : null}
    </div>
  );
}
