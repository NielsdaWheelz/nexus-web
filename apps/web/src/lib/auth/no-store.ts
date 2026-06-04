// A response that carries a rotated auth `Set-Cookie` must never be cached: a
// cached `Set-Cookie` would hand one user another user's session. The auth
// routes that set session cookies (refresh, password, handoff) all run every
// terminal response — including their catch — through this single owner.
export function noStore<T extends Response>(response: T): T {
  response.headers.set("Cache-Control", "no-store");
  return response;
}
