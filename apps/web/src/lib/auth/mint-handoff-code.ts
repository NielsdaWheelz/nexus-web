import { getEnv } from "@/lib/env";
import { boundedAuthFetch } from "@/lib/auth/internal-fetch";
import { internalAuthHeaders } from "@/lib/auth/internal-auth-headers";

// Mints a single-use handoff code against the session tokens. Both the web
// OAuth callback (Flow B) and the native Google sign-in (Flow C) need the same
// POST to `/auth/handoff-codes`; this is the one owner. The discriminated
// return matches the `mintHandoffCode` dep that `handleAuthCallback` consumes;
// the native route maps `error` to its own 502 surface.
export async function mintHandoffCode(args: {
  accessToken: string;
  refreshToken: string;
  challenge: string;
}): Promise<{ code: string } | { error: string }> {
  const { fastApiBaseUrl } = getEnv().internalApi;

  let response: Response;
  try {
    response = await boundedAuthFetch(
      `${fastApiBaseUrl}/auth/handoff-codes`,
      {
        method: "POST",
        headers: internalAuthHeaders({
          accessToken: args.accessToken,
          json: true,
        }),
        body: JSON.stringify({
          access_token: args.accessToken,
          refresh_token: args.refreshToken,
          challenge: args.challenge,
        }),
      },
      "Handoff mint request timed out",
    );
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    // justify-ignore-error: a timed-out or failed mint surfaces to the caller
    // as a single handoff failure; both call sites collapse it to one outcome.
    return { error: "fetch_failed" };
  }

  if (!response.ok) {
    return { error: "non_2xx" };
  }

  const body = await response.json();
  const code = body?.data?.code;
  if (typeof code !== "string" || !code) {
    return { error: "malformed_response" };
  }
  return { code };
}
