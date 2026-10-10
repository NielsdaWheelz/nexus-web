"use server";

import { withActionSession } from "@/lib/auth/session";
import { callbackPath, parseReturnTarget } from "@/lib/auth/urls";
import { getEnv } from "@/lib/env";
import { changeEmail } from "@/lib/supabase/auth";

const EMAIL_CHANGE_FAILURE = "We couldn't update your email. Please try again.";
const EMAIL_IN_USE = "An account with that email already exists.";

// the confirmation link returns through /auth/callback (flow=email) to the
// account pane; the pkce verifier it needs is published with the action.
export async function changeEmailAction({
  email,
}: {
  email: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const normalized = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) {
    return { ok: false, error: EMAIL_CHANGE_FAILURE };
  }
  const callback = callbackPath(
    parseReturnTarget("/settings/account"),
    "email",
  );
  const redirectTo = new URL(callback, getEnv().appPublicOrigin).toString();
  const result = await withActionSession((cookies) =>
    changeEmail(cookies, normalized, redirectTo),
  );
  if (result?.outcome === "Sent") return { ok: true };
  return {
    ok: false,
    error: result?.outcome === "InUse" ? EMAIL_IN_USE : EMAIL_CHANGE_FAILURE,
  };
}
