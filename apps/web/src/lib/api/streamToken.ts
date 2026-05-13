/**
 * Stream token client — fetches a short-lived JWT for direct SSE to fastapi.
 *
 * Per PR-08 spec §11.1:
 * 1. Call POST /api/stream-token (BFF, supabase cookie auth)
 * 2. Receive { token, stream_base_url, expires_at }
 * 3. Use token as Authorization: Bearer for /stream/* endpoints
 */

import { apiFetch } from "@/lib/api/client";

export interface StreamTokenResponse {
  token: string;
  stream_base_url: string;
  expires_at: string;
}

/**
 * Fetch a stream token from the BFF.
 *
 * @throws ApiError if the request fails or returns non-200.
 */
export async function fetchStreamToken(): Promise<StreamTokenResponse> {
  const body = await apiFetch<{ data: StreamTokenResponse }>("/api/stream-token", {
    method: "POST",
  });
  return body.data;
}
