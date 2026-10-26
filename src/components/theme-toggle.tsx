/**
 * Provides accessible light, dark, and system theme selection.
 * Inputs: theme context. Output: a three-option toggle. Expected errors: none.
 * @packageDocumentation
 */
"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { Sun, Moon, Monitor } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Empty subscription for hydration detection. @returns Cleanup. No inputs. @throws No expected errors. */
function subscribe() {
  /** No cleanup is needed. No inputs. @returns Nothing. @throws No expected errors. */
  function cleanup() {}
  return cleanup;
}
/** Signals a mounted browser. No inputs. @returns True. @throws No expected errors. */
function clientSnapshot() { return true; }
/** Signals server rendering. No inputs. @returns False. @throws No expected errors. */
function serverSnapshot() { return false; }

/**
 * Renders theme controls with stable hydration output.
 * @returns Accessible theme toggle. No inputs.
 * @throws No expected errors.
 */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);
  /** Selects light appearance. No inputs. @returns Nothing. @throws No expected errors. */
  function light() { setTheme("light"); }
  /** Selects dark appearance. No inputs. @returns Nothing. @throws No expected errors. */
  function dark() { setTheme("dark"); }
  /** Follows system appearance. No inputs. @returns Nothing. @throws No expected errors. */
  function system() { setTheme("system"); }
  return (
    <div className="flex gap-0.5 rounded-xl border bg-background p-1" role="group" aria-label="Appearance">
      <Button size="icon-sm" variant={mounted && theme === "light" ? "secondary" : "ghost"} onClick={light} aria-label="Light mode" aria-pressed={mounted && theme === "light"} title="Light mode"><Sun className="size-3.5" /></Button>
      <Button size="icon-sm" variant={mounted && theme === "dark" ? "secondary" : "ghost"} onClick={dark} aria-label="Dark mode" aria-pressed={mounted && theme === "dark"} title="Dark mode"><Moon className="size-3.5" /></Button>
      <Button size="icon-sm" variant={mounted && theme === "system" ? "secondary" : "ghost"} onClick={system} aria-label="System theme" aria-pressed={mounted && theme === "system"} title="System theme"><Monitor className="size-3.5" /></Button>
    </div>
  );
}
