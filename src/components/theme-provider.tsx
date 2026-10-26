/**
 * Connects the studio to persisted system, light, and dark theme preferences.
 * Inputs: React children. Output: theme context. Expected errors: none.
 * @packageDocumentation
 */
"use client";

import type { ReactNode } from "react";
import { ThemeProvider as NextThemeProvider } from "next-themes";

/** Compile-time React child contract. */
interface ThemeProviderProps { children: ReactNode; }

/**
 * Applies theme classes before paint and remembers the user's selection.
 * @param props - Child content.
 * @returns Theme provider element.
 * @throws No expected errors.
 */
export function ThemeProvider({ children }: ThemeProviderProps) {
  return <NextThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>{children}</NextThemeProvider>;
}
