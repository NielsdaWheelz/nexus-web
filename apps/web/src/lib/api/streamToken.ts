/**
 * Stream token client — fetches a short-lived JWT for direct SSE to fastapi.
 *
 * Per PR-08 spec §11.1:
 * 1. Call POST /api/stream-token (BFF, supabase cookie auth)
 * 2. Receive { token, stream_base_url, expires_at }
 * 3. Use token as Authorization: Bearer for /stream/* endpoints
 */

export interface StreamTokenResponse {
  token: string;
  stream_base_url: string;
  expires_at: string;
}

/**
 * Fetch a stream token from the BFF.
 *
 * @throws Error if the request fails or returns non-200.
 */
export async function fetchStreamToken(): Promise<StreamTokenResponse> {
  const response = await fetch("/api/stream-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });

  if (!response.ok) {
    let errorMessage = `Stream token request failed with status ${response.status}`;
    try {
      const errorBody = await response.json();
      if (errorBody?.error?.message) {
        errorMessage = errorBody.error.message;
      }
    } catch {
      // ignore parse failures
    }
    throw new Error(errorMessage);
  }

  const body = await response.json();
  return body.data as StreamTokenResponse;
}
