"use server";

import { withActionSession } from "@/lib/auth/session";
import { callbackPath, parseReturnTarget } from "@/lib/auth/urls";
import { getEnv } from "@/lib/env";
import { changeEmail } from "@/lib/supabase/auth";

/**
 * Asks the provider to change the viewer's email. It changes only when the
 * confirmation link (to the new address) returns through /auth/callback
 * (flow=email) to the account pane; the pkce verifier it needs is published
 * with this action.
 */
export async function changeEmailAction(
  email: string,
): Promise<"Sent" | "InUse" | "Invalid" | "Failed" | "Ended"> {
  const address = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) return "Invalid";
  const callback = callbackPath(
    parseReturnTarget("/settings/account"),
    "email",
  );
  const redirectTo = new URL(callback, getEnv().appPublicOrigin).toString();
  const result = await withActionSession((cookies) =>
    changeEmail(cookies, address, redirectTo),
  );
  if (result === "Ended") return "Ended";
  if (result === "Unavailable") return "Failed";
  return result.outcome === "Sent" || result.outcome === "InUse"
    ? result.outcome
    : "Failed";
}
