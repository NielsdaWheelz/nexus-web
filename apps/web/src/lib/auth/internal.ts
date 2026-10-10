// fastapi's internal auth endpoints: handoff codes and extension sessions.
// every failure (transport, the 5 s deadline, a non-2xx, a body without the
// field) is one public outcome per caller: null.
import "server-only";

import { createRandomId } from "@/lib/createRandomId";
import { getEnv } from "@/lib/env";
import type { Tokens } from "@/lib/supabase/auth";
import { isRecord } from "@/lib/validation";

async function post(
  path: string,
  body: object | null,
  { accessToken, requestId }: { accessToken?: string; requestId?: string } = {},
): Promise<Record<string, unknown> | null> {
  const { fastApiBaseUrl, internalSecret } = getEnv().internalApi;
  try {
    const response = await fetch(`${fastApiBaseUrl}${path}`, {
      method: "POST",
      headers: {
        "X-Request-ID": requestId ?? createRandomId(),
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...(internalSecret ? { "X-Nexus-Internal": internalSecret } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    const json: unknown = await response.json();
    return isRecord(json) && isRecord(json.data) ? json.data : null;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return null;
  }
}

const text = (value: unknown) =>
  typeof value === "string" && value ? value : null;

// a single-use code bound to the native verifier's challenge (64 hex).
export async function mintHandoffCode(
  tokens: Tokens,
  challenge: string,
): Promise<string | null> {
  const data = await post(
    "/auth/handoff-codes",
    {
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      challenge,
    },
    { accessToken: tokens.accessToken },
  );
  return text(data?.code);
}

// expired, spent and wrong-verifier codes are one outcome (nothing leaks which).
export async function consumeHandoffCode(
  code: string,
  verifier: string,
): Promise<Tokens | null> {
  const data = await post("/auth/handoff-codes/consume", { code, verifier });
  const accessToken = text(data?.access_token);
  const refreshToken = text(data?.refresh_token);
  return accessToken && refreshToken ? { accessToken, refreshToken } : null;
}

// the extension's bearer for this viewer; requestId is echoed to the extension
// on failure.
export async function createExtensionSession(
  accessToken: string,
  requestId: string,
): Promise<string | null> {
  const data = await post("/auth/extension-sessions", null, {
    accessToken,
    requestId,
  });
  return text(data?.token);
}
