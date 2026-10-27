/**
 * Create a Library set from real photos: name, notes, and one or more photos, linked to the
 * current project when there is one. Also the list of sets with their first photo.
 * @packageDocumentation
 */
"use client";

import Link from "next/link";
import { X } from "lucide-react";
import { useState } from "react";
import { AssetThumb } from "@/components/media/asset-media";
import { Notice } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { UPLOAD_TYPES, errorMessage } from "@/lib/client/api";
import { createSetFromPhotos } from "@/lib/client/references";
import type { SetItem } from "@/lib/domain/library";

export function SetForm({ projectId, onSaved }: { projectId?: string; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await createSetFromPhotos(files, { name, notes }, projectId);
      setName("");
      setNotes("");
      setFiles([]);
      onSaved();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-3 text-sm" aria-label="New set">
      <label className="block space-y-1">
        <span className="text-xs font-medium">Name</span>
        <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Bright kitchen counter by a window" maxLength={120} />
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium">Notes</span>
        <Textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={2} maxLength={1000} placeholder="Morning light from the left, white oak counter" />
      </label>
      <div className="space-y-1">
        <span className="text-xs font-medium">Photos</span>
        <div className="flex flex-wrap gap-2">
          {files.map((file, index) => (
            <span key={`${file.name}-${index}`} className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs">
              {file.name}
              <button type="button" onClick={() => setFiles((current) => current.filter((_, position) => position !== index))} aria-label={`Remove ${file.name}`}>
                <X className="size-3" />
              </button>
            </span>
          ))}
          <label className="inline-flex h-7 cursor-pointer items-center rounded-md border border-dashed px-2 text-xs text-muted-foreground hover:bg-muted/40">
            Add photos
            <input
              type="file"
              accept={UPLOAD_TYPES}
              multiple
              className="sr-only"
              onChange={(event) => {
                const picked = [...(event.target.files ?? [])];
                setFiles((current) => [...current, ...picked].slice(0, 12));
                event.target.value = "";
              }}
            />
          </label>
        </div>
      </div>
      {error ? <Notice>{error}</Notice> : null}
      <Button type="submit" size="sm" disabled={busy || !name.trim()}>
        {projectId ? "Add set to this project" : "Add set"}
      </Button>
    </form>
  );
}

export function SetList({ sets }: { sets: SetItem[] }) {
  if (!sets.length) return <p className="text-xs text-muted-foreground">No sets yet.</p>;
  return (
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
      {sets.map((set) => (
        <Link key={set.id} href={`/library/${set.id}`} className="flex gap-3 rounded-lg border p-3 text-xs hover:bg-muted/40">
          <AssetThumb id={set.imageAssetIds[0]} label="Photo" className="size-16" />
          <div className="min-w-0">
            <div className="font-medium">{set.name}</div>
            <p className="line-clamp-2 text-muted-foreground">{set.notes || `${set.imageAssetIds.length} photo${set.imageAssetIds.length === 1 ? "" : "s"}`}</p>
          </div>
        </Link>
      ))}
    </div>
  );
}
