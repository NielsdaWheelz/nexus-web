"use server";

import {
  EMAIL_CHANGE_FAILURE_MESSAGE,
  toPublicAuthErrorMessage,
} from "@/lib/auth/messages";
import { createClient } from "@/lib/supabase/server";

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
  const { error } = await supabase.auth.updateUser({ email: normalized });
  if (error) {
    return {
      ok: false,
      error: toPublicAuthErrorMessage(error.message) ?? EMAIL_CHANGE_FAILURE_MESSAGE,
    };
  }
  return { ok: true };
}
