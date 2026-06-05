"use server";

import {
  KEEP_ONE_SIGN_IN_METHOD_MESSAGE,
  PASSWORD_CHANGE_FAILURE_MESSAGE,
  PASSWORD_REMOVE_FAILURE_MESSAGE,
  PASSWORD_TOO_SHORT_MESSAGE,
  toPublicAuthErrorMessage,
} from "@/lib/auth/messages";
import {
  findSupabaseIdentityForLinkedIdentity,
  findEmailIdentity,
  mayUnlinkIdentity,
  normalizeLinkedIdentities,
} from "@/lib/auth/identities";
import { createClient } from "@/lib/supabase/server";

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
  const supabaseIdentity = findSupabaseIdentityForLinkedIdentity(
    data,
    emailIdentity
  );
  if (!supabaseIdentity) {
    return { ok: false, error: PASSWORD_REMOVE_FAILURE_MESSAGE };
  }
  const { error } = await supabase.auth.unlinkIdentity(supabaseIdentity);
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
