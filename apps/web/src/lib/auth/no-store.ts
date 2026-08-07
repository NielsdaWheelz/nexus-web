// Auth responses are private even when they do not currently carry a
// `Set-Cookie`: an intermediary must never replay a session-dependent outcome
// or a response that may acquire auth state on a later code path.
export function noStore<T extends Response>(response: T): T {
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Expires", "0");
  response.headers.set("Vary", "Cookie");
  return response;
}
