import { connection } from "next/server";
import { SignInForm } from "@/components/auth/sign-in-form";
import { safeNextPath } from "@creator-lab/core/domain/auth";
import { announceSetupCode, authProvider } from "@/server/auth";

export const metadata = { title: "Sign in · AI Creator Lab" };

/**
 * The sign-in page: on first run on a network it asks for the setup code from the server log and
 * a new password; after that, for the password. Reachable without a session; the proxy sends a
 * loopback-only studio, which needs no password, straight to its projects (see `src/proxy.ts`).
 */
export default async function SignInPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  const query = await searchParams;
  const next = safeNextPath(typeof query.next === "string" ? query.next : undefined);
  const configured = authProvider().configured();
  if (!configured) announceSetupCode();
  return <SignInForm mode={configured ? "sign-in" : "setup"} next={next} />;
}
