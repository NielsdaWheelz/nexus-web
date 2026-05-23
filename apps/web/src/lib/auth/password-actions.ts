"use server";

import { redirect } from "next/navigation";

import {
  DISPLAY_NAME_CHANGE_FAILURE_MESSAGE,
  KEEP_ONE_SIGN_IN_METHOD_MESSAGE,
  PASSWORD_CHANGE_FAILURE_MESSAGE,
  PASSWORD_REMOVE_FAILURE_MESSAGE,
  PASSWORD_SIGN_IN_FAILURE_MESSAGE,
  PASSWORD_SIGN_UP_FAILURE_MESSAGE,
  PASSWORD_TOO_SHORT_MESSAGE,
  toPublicAuthErrorMessage,
} from "@/lib/auth/messages";
import {
  findEmailIdentity,
  mayUnlinkIdentity,
  normalizeLinkedIdentities,
} from "@/lib/auth/identities";
import { boundedAuthFetch } from "@/lib/auth/internal-fetch";
import { getInternalApiConfig } from "@/lib/api/internal-config";
import { createClient } from "@/lib/supabase/server";

export async function signInWithPasswordAction(input: {
  email: string;
  password: string;
  nextPath?: string;
}): Promise<{ ok: false; error: string }> {
  const email = input.email.trim().toLowerCase();
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email,
    password: input.password,
  });
  if (error) {
    return {
      ok: false,
      error:
        toPublicAuthErrorMessage(error.message) ??
        PASSWORD_SIGN_IN_FAILURE_MESSAGE,
    };
  }
  const nextPath = input.nextPath;
  const safeNextPath =
    nextPath && nextPath.startsWith("/") && !nextPath.startsWith("//")
      ? nextPath
      : "/libraries";
  redirect(safeNextPath);
}

export async function signUpWithPasswordAction(input: {
  email: string;
  password: string;
  displayName: string;
}): Promise<{ ok: false; error: string }> {
  const email = input.email.trim().toLowerCase();
  const displayName = input.displayName.trim();
  if (displayName.length < 1 || displayName.length > 80) {
    return { ok: false, error: DISPLAY_NAME_CHANGE_FAILURE_MESSAGE };
  }
  if (input.password.length < 12) {
    return { ok: false, error: PASSWORD_TOO_SHORT_MESSAGE };
  }
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password: input.password,
    options: { data: { display_name: displayName } },
  });
  if (error) {
    return {
      ok: false,
      error:
        toPublicAuthErrorMessage(error.message) ??
        PASSWORD_SIGN_UP_FAILURE_MESSAGE,
    };
  }
  if (!data.session) {
    return { ok: false, error: PASSWORD_SIGN_UP_FAILURE_MESSAGE };
  }

  const config = getInternalApiConfig();
  let response: Response;
  try {
    response = await boundedAuthFetch(
      `${config.fastApiBaseUrl}/me`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${data.session.access_token}`,
          "Content-Type": "application/json",
          "X-Nexus-Internal": config.internalSecret,
          "X-Request-ID": crypto.randomUUID(),
        },
        body: JSON.stringify({ display_name: displayName }),
      },
      "Display-name PATCH timed out",
    );
  } catch (fetchError) {
    if (!(fetchError instanceof Error)) {
      throw fetchError;
    }
    // justify-ignore-error: the Supabase user already exists; the spec accepts a
    // partially complete signup. The user can re-attempt the display-name set
    // from /settings/account later.
    return { ok: false, error: PASSWORD_SIGN_UP_FAILURE_MESSAGE };
  }
  if (!response.ok) {
    return { ok: false, error: PASSWORD_SIGN_UP_FAILURE_MESSAGE };
  }
  redirect("/libraries");
}

export async function setPasswordAction(input: {
  password: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (input.password.length < 12) {
    return { ok: false, error: PASSWORD_TOO_SHORT_MESSAGE };
  }
  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password: input.password });
  if (error) {
    return {
      ok: false,
      error:
        toPublicAuthErrorMessage(error.message) ??
        PASSWORD_CHANGE_FAILURE_MESSAGE,
    };
  }
  return { ok: true };
}

export async function changePasswordAction(input: {
  password: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (input.password.length < 12) {
    return { ok: false, error: PASSWORD_TOO_SHORT_MESSAGE };
  }
  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password: input.password });
  if (error) {
    return {
      ok: false,
      error:
        toPublicAuthErrorMessage(error.message) ??
        PASSWORD_CHANGE_FAILURE_MESSAGE,
    };
  }
  return { ok: true };
}

export async function removePasswordAction(): Promise<
  { ok: true } | { ok: false; error: string }
> {
  const supabase = await createClient();
  const { data, error: loadError } = await supabase.auth.getUserIdentities();
  if (loadError) {
    return { ok: false, error: PASSWORD_REMOVE_FAILURE_MESSAGE };
  }
  const identities = normalizeLinkedIdentities(data);
  const emailIdentity = findEmailIdentity(identities);
  if (!emailIdentity) {
    return { ok: false, error: PASSWORD_REMOVE_FAILURE_MESSAGE };
  }
  if (!mayUnlinkIdentity(identities, emailIdentity.id)) {
    return { ok: false, error: KEEP_ONE_SIGN_IN_METHOD_MESSAGE };
  }
  const unlinkPayload = {
    identity_id: emailIdentity.id,
    provider: emailIdentity.provider,
  } as Parameters<typeof supabase.auth.unlinkIdentity>[0];
  const { error } = await supabase.auth.unlinkIdentity(unlinkPayload);
  if (error) {
    return {
      ok: false,
      error:
        toPublicAuthErrorMessage(error.message) ??
        PASSWORD_REMOVE_FAILURE_MESSAGE,
    };
  }
  return { ok: true };
}
