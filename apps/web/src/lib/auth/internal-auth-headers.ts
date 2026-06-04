import { getEnv } from "@/lib/env";
import { createRandomId } from "@/lib/createRandomId";

// Every BFF route that calls an internal FastAPI auth endpoint hand-builds the
// same header set: a fresh `X-Request-ID`, the shared `X-Nexus-Internal` secret
// (only when configured), and — when the call carries a user — a Supabase
// bearer. This is the one owner of that idiom so the internal-secret spread and
// request-id minting are not copy-pasted across five routes.
export function internalAuthHeaders(options?: {
  accessToken?: string;
  json?: boolean;
  // Supply a pre-minted id when the same correlation id must also appear
  // elsewhere in the response (e.g. an error redirect's `request_id`).
  requestId?: string;
}): Record<string, string> {
  const { internalSecret } = getEnv().internalApi;
  const headers: Record<string, string> = {
    "X-Request-ID": options?.requestId ?? createRandomId(),
  };
  if (options?.accessToken) {
    headers.Authorization = `Bearer ${options.accessToken}`;
  }
  if (options?.json) {
    headers["Content-Type"] = "application/json";
  }
  if (internalSecret) {
    headers["X-Nexus-Internal"] = internalSecret;
  }
  return headers;
}
