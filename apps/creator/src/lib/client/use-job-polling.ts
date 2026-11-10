/**
 * Polls a project's jobs route every two seconds while it has unfinished jobs, and calls `onChange`
 * when the set of unfinished jobs changes (a job finished or a new one started). Stops when idle;
 * `kick()` restarts it after a submit.
 * @packageDocumentation
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getJson } from "@/lib/client/api";
import { shouldPoll } from "@/lib/client/format";
import type { Job, JobsView } from "@/lib/client/types";

export const POLL_INTERVAL_MS = 2000;

export function useJobPolling(projectId: string, onChange: () => void): { unfinished: Job[]; recent: Job[]; kick: () => void } {
  const [view, setView] = useState<JobsView>({ unfinished: [], recent: [] });
  const [active, setActive] = useState(true);
  const signature = useRef("");
  const changed = useRef(onChange);
  useEffect(() => {
    changed.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const next = await getJson<JobsView>(`/api/projects/${projectId}/jobs`);
        if (stopped) return;
        setView(next);
        const key = next.unfinished.map((job) => `${job.id}:${job.status}`).join(",");
        if (key !== signature.current) {
          signature.current = key;
          changed.current();
        }
        if (!shouldPoll(next.unfinished)) {
          setActive(false);
          return;
        }
      } catch {
        // Keep polling through transient errors.
      }
      if (!stopped) timer = setTimeout(tick, POLL_INTERVAL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [projectId, active]);

  const kick = useCallback(() => setActive(true), []);
  return { ...view, kick };
}
