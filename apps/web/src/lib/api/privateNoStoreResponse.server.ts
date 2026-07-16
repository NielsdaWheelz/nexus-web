import "server-only";

const PRIVATE_NO_STORE_CACHE_CONTROL = "private, no-store";

// The header must be stamped on proxied AND locally generated (proxy-error)
// responses, mirroring the FastAPI middleware.
export function privateNoStoreResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", PRIVATE_NO_STORE_CACHE_CONTROL);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
