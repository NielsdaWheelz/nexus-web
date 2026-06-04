import { getEnv } from "@/lib/env";
import { boundedAuthFetch } from "@/lib/auth/internal-fetch";
import { internalAuthHeaders } from "@/lib/auth/internal-auth-headers";
import {
  DISPLAY_NAME_CHANGE_FAILURE_MESSAGE,
  PASSWORD_SIGN_IN_FAILURE_MESSAGE,
  PASSWORD_SIGN_UP_FAILURE_MESSAGE,
  PASSWORD_TOO_SHORT_MESSAGE,
  toPublicAuthErrorMessage,
} from "@/lib/auth/messages";

type AuthError = { message: string };
type PasswordSession = { access_token: string };

export interface PasswordAuthClient {
  auth: {
    signInWithPassword(input: {
      email: string;
      password: string;
    }): Promise<{ error: AuthError | null }>;
    signUp(input: {
      email: string;
      password: string;
      options: { data: { display_name: string } };
    }): Promise<{
      data: { session: PasswordSession | null };
      error: AuthError | null;
    }>;
  };
}

export type PasswordFlowResult =
  | { ok: true }
  | { ok: false; error: string };

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function patchDisplayName(
  accessToken: string,
  displayName: string,
): Promise<boolean> {
  const { fastApiBaseUrl } = getEnv().internalApi;
  try {
    const response = await boundedAuthFetch(
      `${fastApiBaseUrl}/me`,
      {
        method: "PATCH",
        headers: internalAuthHeaders({ accessToken, json: true }),
        body: JSON.stringify({ display_name: displayName }),
      },
      "Display-name PATCH timed out",
    );
    return response.ok;
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    return false;
  }
}

export async function signInWithPasswordFlow(
  supabase: PasswordAuthClient,
  input: { email: string; password: string },
): Promise<PasswordFlowResult> {
  const { error } = await supabase.auth.signInWithPassword({
    email: normalizeEmail(input.email),
    password: input.password,
  });
  if (!error) {
    return { ok: true };
  }
  return {
    ok: false,
    error:
      toPublicAuthErrorMessage(error.message) ??
      PASSWORD_SIGN_IN_FAILURE_MESSAGE,
  };
}

export async function signUpWithPasswordFlow(
  supabase: PasswordAuthClient,
  input: { email: string; password: string; displayName: string },
): Promise<PasswordFlowResult> {
  const email = normalizeEmail(input.email);
  const displayName = input.displayName.trim();
  if (displayName.length < 1 || displayName.length > 80) {
    return { ok: false, error: DISPLAY_NAME_CHANGE_FAILURE_MESSAGE };
  }
  if (input.password.length < 12) {
    return { ok: false, error: PASSWORD_TOO_SHORT_MESSAGE };
  }

  const { data, error } = await supabase.auth.signUp({
    email,
    password: input.password,
    options: { data: { display_name: displayName } },
  });
  if (error || !data.session) {
    return {
      ok: false,
      error:
        toPublicAuthErrorMessage(error?.message) ??
        PASSWORD_SIGN_UP_FAILURE_MESSAGE,
    };
  }

  const displayNameUpdated = await patchDisplayName(
    data.session.access_token,
    displayName,
  );
  if (!displayNameUpdated) {
    return { ok: false, error: PASSWORD_SIGN_UP_FAILURE_MESSAGE };
  }
  return { ok: true };
}
