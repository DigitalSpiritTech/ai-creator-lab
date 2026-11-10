/**
 * The reference sheet inspection checklist shown with sheet candidates. Approval waits until every
 * item is checked against the full-size view.
 * @packageDocumentation
 */
"use client";

export function sheetChecklist(wardrobe: string | null): string[] {
  return [
    "One large portrait plus full-body front and full-body back",
    "The same face and identity in every panel, matching the locked face",
    `Wardrobe matches this project${wardrobe ? `: ${wardrobe}` : ""}`,
    "Neutral grey background, even light",
    "No extra people, text, logos, or watermarks; hands and feet intact",
  ];
}

export function SheetChecklist({ items, checked, onChange }: { items: string[]; checked: boolean[]; onChange: (next: boolean[]) => void }) {
  return (
    <fieldset className="rounded-lg border p-3 text-xs">
      <legend className="px-1 font-medium">Inspection checklist</legend>
      <ul className="space-y-1">
        {items.map((item, index) => (
          <li key={item}>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={checked[index] ?? false}
                onChange={(event) => onChange(items.map((_, position) => (position === index ? event.target.checked : (checked[position] ?? false))))}
              />
              {item}
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}
