"use server";

import { headers } from "next/headers";

import {
  EMAIL_CHANGE_FAILURE_MESSAGE,
  toPublicAuthErrorMessage,
} from "@/lib/auth/messages";
import { buildAuthCallbackUrl } from "@/lib/auth/redirects";
import { createClient } from "@/lib/supabase/server";

function resolveServerActionOrigin(requestHeaders: Headers): string {
  const host =
    requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  if (!host) {
    return "http://localhost:3000";
  }
  const forwardedProto = requestHeaders.get("x-forwarded-proto");
  const protocol =
    forwardedProto ??
    (host.startsWith("localhost") || host.startsWith("127.0.0.1")
      ? "http"
      : "https");
  return `${protocol}://${host}`;
}

export async function changeEmailAction({
  email,
}: {
  email: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const normalized = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) {
    return { ok: false, error: EMAIL_CHANGE_FAILURE_MESSAGE };
  }

  const supabase = await createClient();
  const redirectOrigin = resolveServerActionOrigin(await headers());
  const { error } = await supabase.auth.updateUser(
    { email: normalized },
    {
      emailRedirectTo: buildAuthCallbackUrl(
        redirectOrigin,
        "/settings/account"
      ),
    }
  );
  if (error) {
    return {
      ok: false,
      error: toPublicAuthErrorMessage(error.message) ?? EMAIL_CHANGE_FAILURE_MESSAGE,
    };
  }
  return { ok: true };
}
