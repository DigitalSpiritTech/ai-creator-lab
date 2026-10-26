/**
 * Create or edit a Library product (`save_product`): name, link, allowed claims, and photos.
 * @packageDocumentation
 */
"use client";

import { ImagePlus, X } from "lucide-react";
import { useState } from "react";
import { AssetThumb } from "@/components/media/asset-media";
import { Notice } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { callTool, errorMessage, uploadImage } from "@/lib/client/api";
import type { ProductItem } from "@/lib/domain/library";

export function ProductForm({ product, onSaved }: { product?: ProductItem; onSaved: () => void }) {
  const [name, setName] = useState(product?.name ?? "");
  const [link, setLink] = useState(product?.link ?? "");
  const [claims, setClaims] = useState((product?.allowedClaims ?? []).join("\n"));
  const [images, setImages] = useState<string[]>(product?.imageAssetIds ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    try {
      const added: string[] = [];
      for (const file of [...files]) added.push((await uploadImage(file)).asset.id);
      setImages((current) => [...current, ...added.filter((id) => !current.includes(id))].slice(0, 12));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await callTool("save_product", {
        productId: product?.id,
        revision: product?.revision,
        product: {
          name: name.trim(),
          link: link.trim() || null,
          allowedClaims: claims.split("\n").map((claim) => claim.trim()).filter(Boolean),
          imageAssetIds: images,
        },
      });
      onSaved();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-3 text-sm" aria-label="Product">
      <label className="block space-y-1">
        <span className="text-xs font-medium">Name</span>
        <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Ridgeline 32 oz insulated bottle" maxLength={120} />
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium">Link</span>
        <Input value={link} onChange={(event) => setLink(event.target.value)} placeholder="https://example.com/ridgeline-32" type="url" />
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium">Claims the ad may make (one per line)</span>
        <Textarea value={claims} onChange={(event) => setClaims(event.target.value)} rows={4} placeholder={"Keeps drinks cold 24 hours\nFits a car cup holder\nDishwasher safe"} />
      </label>
      <div className="space-y-1">
        <span className="text-xs font-medium">Photos</span>
        <div className="flex flex-wrap gap-2">
          {images.map((id) => (
            <div key={id} className="relative">
              <AssetThumb id={id} label="Product photo" className="size-20" />
              <button type="button" className="absolute top-0.5 right-0.5 rounded bg-background/80 p-0.5" onClick={() => setImages((current) => current.filter((entry) => entry !== id))} aria-label="Remove photo">
                <X className="size-3" />
              </button>
            </div>
          ))}
          <label className="flex size-20 cursor-pointer flex-col items-center justify-center gap-1 rounded-md border border-dashed text-xs text-muted-foreground hover:bg-muted/40">
            <ImagePlus className="size-4" /> Upload
            <input type="file" accept="image/png,image/jpeg,image/webp" multiple className="sr-only" onChange={(event) => void upload(event.target.files)} />
          </label>
        </div>
      </div>
      {error ? <Notice>{error}</Notice> : null}
      <Button type="submit" disabled={busy || !name.trim()}>{product ? "Save product" : "Add product"}</Button>
    </form>
  );
}
