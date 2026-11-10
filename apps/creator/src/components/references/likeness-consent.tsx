/**
 * The likeness permission checkbox shown before a real photo of a person is uploaded as a face or
 * body reference. One component so it can be removed in one place.
 * @packageDocumentation
 */
"use client";

export function LikenessConsent({ checked, onChange, id }: { checked: boolean; onChange: (checked: boolean) => void; id: string }) {
  return (
    <label htmlFor={id} className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
      <input id={id} type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="mt-0.5" />
      I have permission to use this person&apos;s likeness.
    </label>
  );
}
