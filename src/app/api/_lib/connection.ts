/**
 * The Settings connection check: reads the Comfy Cloud credit balance and account status with the
 * user's key. Every failure becomes a readable message; the key is only ever sent as a header.
 * @packageDocumentation
 */
import { z } from "zod";
import { CREDITS_PER_BALANCE_CENT } from "@/server/executors/allowance";

const COMFY_API = "https://cloud.comfy.org/api";

const BalanceSchema = z
  .object({
    effective_balance_cents: z.number(),
    cloud_credit_balance_cents: z.number().optional(),
    prepaid_balance_cents: z.number().optional(),
  })
  .passthrough();
const UserSchema = z.object({ status: z.string().max(80) }).passthrough();

export interface ConnectionStatus {
  configured: boolean;
  ok: boolean;
  /** Account status as Comfy reports it, for example "active"; null when unknown. */
  status: string | null;
  credits: number | null;
  cloudCredits: number | null;
  prepaidCredits: number | null;
  message: string;
  checkedAt: number;
}

const credits = (cents: number | undefined) => (cents === undefined ? null : Math.round(cents * CREDITS_PER_BALANCE_CENT));

async function getJson(path: string, apiKey: string, fetchImpl: typeof fetch): Promise<{ ok: true; body: unknown } | { ok: false; status: number | null }> {
  try {
    const response = await fetchImpl(`${COMFY_API}${path}`, {
      headers: { "X-API-Key": apiKey, Accept: "application/json" },
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { ok: false, status: response.status };
    }
    return { ok: true, body: await response.json().catch(() => undefined) };
  } catch {
    return { ok: false, status: null };
  }
}

/** Checks the key against Comfy Cloud. Never throws. */
export async function checkComfyConnection(apiKey: string | undefined, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<ConnectionStatus> {
  const base = { status: null, credits: null, cloudCredits: null, prepaidCredits: null, checkedAt: now };
  if (!apiKey) return { ...base, configured: false, ok: false, message: "Add a Comfy API key to check the connection." };
  const [balance, user] = await Promise.all([getJson("/billing/balance", apiKey, fetchImpl), getJson("/user", apiKey, fetchImpl)]);
  if (!balance.ok) {
    const message =
      balance.status === 401 || balance.status === 403
        ? "Comfy did not accept this API key. Check it and save it again."
        : balance.status === null
          ? "Comfy Cloud could not be reached. Check your connection and try again."
          : `Comfy Cloud answered with an error (${balance.status}). Try again in a minute.`;
    return { ...base, configured: true, ok: false, message };
  }
  const parsedBalance = BalanceSchema.safeParse(balance.body);
  if (!parsedBalance.success) return { ...base, configured: true, ok: false, message: "The Comfy balance response was not understood." };
  const parsedUser = user.ok ? UserSchema.safeParse(user.body) : undefined;
  const status = parsedUser?.success ? parsedUser.data.status : null;
  const total = credits(parsedBalance.data.effective_balance_cents)!;
  const statusText = status ? `Account ${status.replaceAll("_", " ")}` : "Account status unavailable";
  return {
    ...base,
    configured: true,
    ok: true,
    status,
    credits: total,
    cloudCredits: credits(parsedBalance.data.cloud_credit_balance_cents),
    prepaidCredits: credits(parsedBalance.data.prepaid_balance_cents),
    message: `Connected. ${statusText}; ${total.toLocaleString("en-US")} credits available.`,
  };
}
