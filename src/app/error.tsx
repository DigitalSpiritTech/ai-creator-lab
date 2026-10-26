/**
 * Provides recovery UI when the local workspace cannot load.
 * Inputs: framework error-reset callback. Output: retry panel. Expected errors: none.
 * @packageDocumentation
 */
"use client";

import { Button } from "@/components/ui/button";

/** Framework error-recovery port. */
interface ErrorProps {
  /** Retries route rendering. No inputs. @returns Nothing. @throws No expected errors. */
  reset(): void;
}

/**
 * Displays an actionable local storage failure.
 * @param props - Retry callback.
 * @returns Error panel without internal paths or exception details.
 * @throws No expected errors.
 */
export default function StudioError({ reset }: ErrorProps) {
  return <main className="mx-auto max-w-lg p-10"><h1 className="text-2xl font-semibold">The workspace couldn’t open.</h1><p className="my-5 text-sm leading-6 text-muted-foreground">Check that your studio data folder is writable and has available disk space. Your existing files have not been reset.</p><Button onClick={reset}>Try again</Button></main>;
}
