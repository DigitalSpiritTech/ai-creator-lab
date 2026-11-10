"use client";
/**
 * The sign-in card, drawn over the shell. Setup mode asks for the code from the server log and a
 * new password (twice); sign-in mode asks for the password. On success the browser loads the page
 * it came from, so the shell renders signed in.
 * @packageDocumentation
 */
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@creator-lab/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@creator-lab/ui/card";
import { Input } from "@creator-lab/ui/input";
import { AUTH_PASSWORD_MIN_LENGTH, type AuthStatus } from "@creator-lab/core/domain/auth";

export function SignInForm({ mode, next }: { mode: "setup" | "sign-in"; next: string }) {
  const [setupCode, setSetupCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A link from another site arrives without the SameSite=Strict cookie; a same-origin check
  // finds a live session and goes on without asking again.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/session", { cache: "no-store" })
      .then((response) => (response.ok ? (response.json() as Promise<AuthStatus>) : null))
      .then((status) => {
        if (!cancelled && status && (status.authenticated || !status.required)) window.location.replace(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [next]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (mode === "setup" && password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(mode === "setup" ? "/api/auth/setup" : "/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mode === "setup" ? { setupCode, password } : { password }),
      });
      if (response.ok) {
        window.location.replace(next);
        return;
      }
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? "Sign-in did not work. Try again.");
      if (response.status === 409) window.location.reload();
    } catch {
      setError("The studio did not answer. Check that the server is running.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{mode === "setup" ? "Choose a password for this studio" : "Sign in to AI Creator Lab"}</CardTitle>
          <CardDescription>
            {mode === "setup"
              ? "This studio is reachable from other computers, so it needs a password. Enter the setup code printed in the server's log, then choose a password."
              : "This studio is reachable from other computers. Enter its password."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-3" onSubmit={submit}>
            {mode === "setup" ? (
              <label className="flex flex-col gap-1 text-sm">
                Setup code
                <Input value={setupCode} onChange={(event) => setSetupCode(event.target.value)} autoComplete="one-time-code" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX" required autoFocus />
              </label>
            ) : null}
            <label className="flex flex-col gap-1 text-sm">
              {mode === "setup" ? "New password" : "Password"}
              <Input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete={mode === "setup" ? "new-password" : "current-password"}
                minLength={mode === "setup" ? AUTH_PASSWORD_MIN_LENGTH : undefined}
                required
                autoFocus={mode === "sign-in"}
              />
            </label>
            {mode === "setup" ? (
              <label className="flex flex-col gap-1 text-sm">
                Repeat the password
                <Input type="password" value={confirm} onChange={(event) => setConfirm(event.target.value)} autoComplete="new-password" required />
              </label>
            ) : null}
            {mode === "setup" ? <p className="text-xs text-muted-foreground">At least {AUTH_PASSWORD_MIN_LENGTH} characters.</p> : null}
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <Button type="submit" disabled={busy}>
              {busy ? "Checking…" : mode === "setup" ? "Set password and sign in" : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
