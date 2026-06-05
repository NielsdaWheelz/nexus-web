"use server";

import { headers } from "next/headers";

import { resolveServerActionRedirectOrigin } from "@/lib/auth/callback-origin";
import {
  EMAIL_CHANGE_FAILURE_MESSAGE,
  toPublicAuthErrorMessage,
} from "@/lib/auth/messages";
import {
  buildAuthCallbackUrl,
  parseAuthReturnTarget,
} from "@/lib/auth/redirects";
import { createClient } from "@/lib/supabase/server";

const SETTINGS_ACCOUNT_RETURN_TARGET = parseAuthReturnTarget("/settings/account");

export async function changeEmailAction({
  email,
}: {
  email: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const normalized = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) {
    return { ok: false, error: EMAIL_CHANGE_FAILURE_MESSAGE };
  }

  let redirectOrigin: string;
  try {
    redirectOrigin = resolveServerActionRedirectOrigin(await headers());
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    // justify-ignore-error: a misconfigured allowlist or a spoofed Host must
    // fail closed as the public failure message — no confirmation link is minted
    // and the raw resolver error (which names env vars) never reaches the client.
    console.error("auth_email_change_origin_rejected", {
      reason: error.message,
    });
    return { ok: false, error: EMAIL_CHANGE_FAILURE_MESSAGE };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser(
    { email: normalized },
    {
      emailRedirectTo: buildAuthCallbackUrl(
        redirectOrigin,
        SETTINGS_ACCOUNT_RETURN_TARGET
      ),
    }
  );
  if (error) {
    return {
      ok: false,
      error:
        toPublicAuthErrorMessage(error.message) ?? EMAIL_CHANGE_FAILURE_MESSAGE,
    };
  }
  return { ok: true };
}
