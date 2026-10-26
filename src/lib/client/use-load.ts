/**
 * Runs an async loader after mount and whenever it changes. Scheduled as a task so the loader's
 * state updates land after the effect, not inside it.
 * @packageDocumentation
 */
"use client";

import { useEffect } from "react";

export function useLoad(load: () => Promise<void>): void {
  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);
}
