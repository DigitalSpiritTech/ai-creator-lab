"use client";
/**
 * Read-only demo mode on the client: a banner across the top and a hook the inputs use to
 * switch themselves off. The server decides the mode; this only reflects it.
 * @packageDocumentation
 */
import { createContext, useContext, type ReactNode } from "react";

const DemoContext = createContext(false);

export function DemoProvider({ readOnly, children }: { readOnly: boolean; children: ReactNode }) {
  return <DemoContext.Provider value={readOnly}>{children}</DemoContext.Provider>;
}

/** True when the server runs as a read-only demo. */
export function useReadOnly(): boolean {
  return useContext(DemoContext);
}

export function JudgeBanner({ repository }: { repository: string }) {
  return (
    <div role="status" className="border-b border-sky-500/40 bg-sky-500/10 px-4 py-2 text-center text-xs text-sky-900 dark:text-sky-200">
      Judging copy. Generation runs on the author&apos;s Comfy account under a capped allowance; please keep to a few runs. Source:{" "}
      <a className="underline" href={repository} target="_blank" rel="noreferrer">
        {repository.replace(/^https?:\/\//, "")}
      </a>
    </div>
  );
}

export function DemoBanner({ repository }: { repository: string }) {
  const readOnly = useReadOnly();
  if (!readOnly) return null;
  return (
    <div role="status" className="border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-center text-xs text-amber-900 dark:text-amber-200">
      Read-only demo. Look around every project, asset and export; nothing can be changed or generated here. To make your own, run it on your computer:{" "}
      <a className="underline" href={repository} target="_blank" rel="noreferrer">
        {repository.replace(/^https?:\/\//, "")}
      </a>
    </div>
  );
}
