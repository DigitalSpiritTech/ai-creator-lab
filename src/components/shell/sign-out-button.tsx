"use client";
/**
 * Sign out, shown in the rail only when this browser is signed in to a studio that asks for the
 * app password.
 * @packageDocumentation
 */
import { LogOut } from "lucide-react";
import { useState } from "react";

export function SignOutButton() {
  const [busy, setBusy] = useState(false);
  async function signOut() {
    setBusy(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      window.location.replace("/login");
    }
  }
  return (
    <button
      type="button"
      onClick={signOut}
      disabled={busy}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground disabled:opacity-50"
    >
      <LogOut className="size-4" aria-hidden />
      Sign out
    </button>
  );
}
