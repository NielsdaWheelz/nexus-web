// the server half of the supabase boundary (cookie.ts is the edge-safe half):
// the sdk client, verification, the one refresh owner and every provider
// operation with its error table. nothing outside lib/supabase imports
// @supabase/*.
//
// every operation takes cookies in and gives cookie writes out: the caller
// publishes the writes on the response it owns. an establishing operation
// never sees the presented session. the provider not answering (no response,
// a gateway 5xx, the deadline) is a modelled outcome where the journey has
// one, else AuthUnavailable. a provider error its table does not model is a
// defect: it throws.
import "server-only";

import { createServerClient, type CookieOptions } from "@supabase/ssr";
import {
  isAuthError,
  isAuthRetryableFetchError,
  isAuthSessionMissingError,
  isAuthWeakPasswordError,
  type AuthError,
} from "@supabase/supabase-js";
import { isOAuthProvider, type OAuthProvider } from "@/lib/auth/urls";
import { getEnv } from "@/lib/env";
import {
  applyWrites,
  authCookieNames,
  decodeSessionCookie,
  readSession,
  type CookieValue,
} from "./cookie";

export interface CookieWrite {
  readonly name: string;
  readonly value: string;
  readonly options?: CookieOptions;
}
export interface Viewer {
  readonly userId: string;
  readonly email: string | null;
}
export interface Tokens {
  readonly accessToken: string;
  readonly refreshToken: string;
}
export interface LinkedIdentity {
  readonly id: string;
  readonly provider: OAuthProvider;
  readonly email: string | null;
  readonly createdAt: string | null;
}

// thrown by verify and refresh only: the caller keeps the credentials and
// answers 503.
export class AuthUnavailable extends Error {
  override readonly name = "AuthUnavailable";
}

const OPERATION_DEADLINE_MS = 5_000;
const VERIFY_DEADLINE_MS = 2_000;

type Settled<R> =
  R | { data: null; error: AuthError } | { unavailable: number };

// one sdk client per operation: an in-memory jar seeded from the caller's
// cookies, the writes the caller publishes, and one deadline for everything
// the operation does. the deadline is every sdk fetch's signal and is raced by
// call(), so it also bounds the sdk's own retry backoff, which a per-fetch
// abort does not.
function client(
  cookies: readonly CookieValue[],
  deadlineMs = OPERATION_DEADLINE_MS,
) {
  let jar = [...cookies];
  const writes: CookieWrite[] = [];
  const deadline = AbortSignal.timeout(deadlineMs);
  const { url, anonKey } = getEnv().supabase;
  const { auth } = createServerClient(url, anonKey, {
    // httpOnly: no browser client reads it. lax: it rides the top-level oauth
    // callback redirect. secure: whenever the one app origin is https.
    cookieOptions: {
      httpOnly: true,
      secure: getEnv().appPublicOrigin.startsWith("https:"),
      sameSite: "lax",
      path: "/",
    },
    cookies: {
      getAll: () => jar,
      setAll: (next) => {
        writes.push(...next);
        jar = applyWrites(jar, next);
      },
    },
    global: {
      fetch: (input, init) => fetch(input, { ...init, signal: deadline }),
    },
  });
  // the sdk both returns and throws AuthError. `unavailable` carries the http
  // status (0: no response, or the deadline) for the one journey that tells
  // them apart.
  async function call<R extends { data: unknown; error: AuthError | null }>(
    operation: Promise<R>,
  ): Promise<Settled<R>> {
    const expired = new Promise<{ unavailable: number }>((resolve) => {
      if (deadline.aborted) resolve({ unavailable: 0 });
      deadline.addEventListener("abort", () => resolve({ unavailable: 0 }));
    });
    let result: Settled<R>;
    try {
      result = await Promise.race([operation, expired]);
    } catch (error) {
      if (!isAuthError(error)) throw error;
      result = { data: null, error };
    }
    if ("error" in result && isAuthRetryableFetchError(result.error)) {
      return { unavailable: result.error.status };
    }
    return result;
  }
  return { auth, writes, call };
}

// a new session must not be shadowed by the presented one: the names stay
// (the sdk deletes stale chunks by name), the values go.
function withoutSession(cookies: readonly CookieValue[]): CookieValue[] {
  const names = new Set(authCookieNames(cookies));
  return cookies.map((c) => ({
    ...c,
    value: names.has(c.name) ? "" : c.value,
  }));
}

// verification and refresh also treat throttling, any 5xx, timeouts and
// conflicts as the provider being unavailable.
function isDependencyFailure(error: AuthError): boolean {
  return (
    error.status === 429 ||
    (error.status ?? 0) >= 500 ||
    error.code === "request_timeout" ||
    error.code === "conflict"
  );
}

// the provider no longer honours the presented session: signed out or revoked
// elsewhere (session_not_found arrives as AuthSessionMissingError), the user
// banned or deleted, or a token it rejects (it verifies the bearer on every
// write). the caller clears the session.
const ENDED_AT_PROVIDER = new Set([
  "bad_jwt",
  "session_expired",
  "user_banned",
  "user_not_found",
]);
const endedAtProvider = (error: AuthError) =>
  isAuthSessionMissingError(error) || ENDED_AT_PROVIDER.has(error.code ?? "");

function unexpected(operation: string, error: AuthError): never {
  // justify-defect: the operation's reachable provider states are modelled; a
  // new or codeless one is provider-contract drift.
  throw new Error(
    `Unexpected Supabase ${operation} error: ${error.code ?? error.name}`,
  );
}

// verification: is this access token the provider's, and whose.
export async function verify(
  accessToken: string,
): Promise<Viewer | "Rejected"> {
  const { auth, writes, call } = client([], VERIFY_DEADLINE_MS);
  const result = await call(auth.getClaims(accessToken));
  // read-only: a server component can never publish a write.
  if (writes.length > 0) {
    throw new Error("Supabase verification wrote a cookie");
  }
  if ("unavailable" in result) throw new AuthUnavailable();
  const { data, error } = result;
  if (error) {
    if (isDependencyFailure(error)) throw new AuthUnavailable();
    // an expired or forged token, or (verified by the provider for a
    // symmetric key) one whose session has been signed out elsewhere.
    const rejected =
      error.name === "AuthInvalidJwtError" ||
      error.code === "invalid_jwt" ||
      isAuthSessionMissingError(error);
    if (rejected) return "Rejected";
    return unexpected("verification", error);
  }
  const { sub, email } = data?.claims ?? {};
  if (typeof sub !== "string" || !sub) {
    throw new Error("Supabase verification succeeded without a subject");
  }
  return { userId: sub, email: typeof email === "string" ? email : null };
}

// refresh: the only place a refresh token is spent. one in-flight provider
// refresh per presented cookie per process (supabase's
// refresh_token_reuse_interval owns the cross-instance race), keyed by a
// digest so no bearer becomes a map key.
export type Refreshed =
  | {
      readonly kind: "Refreshed";
      readonly accessToken: string;
      readonly cookies: readonly CookieValue[];
      readonly writes: readonly CookieWrite[];
    }
  | { readonly kind: "Ended" };

const ENDED_ON_REFRESH = new Set([
  // local and hosted auth report an invalid refresh-grant value this way.
  "validation_failed",
  "refresh_token_not_found",
  "refresh_token_already_used",
  "session_not_found",
  "session_expired",
  "user_not_found",
  "user_banned",
]);
const inFlight = new Map<string, Promise<Refreshed>>();

export async function refresh(
  cookies: readonly CookieValue[],
): Promise<Refreshed> {
  const presented = decodeSessionCookie(cookies);
  const refreshToken = presented?.refreshToken;
  if (!presented || !refreshToken) return { kind: "Ended" };
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(presented.value),
  );
  const key = Buffer.from(digest).toString("hex");
  let pending = inFlight.get(key);
  if (!pending) {
    pending = runRefresh(cookies, refreshToken).finally(() =>
      inFlight.delete(key),
    );
    inFlight.set(key, pending);
  }
  return pending;
}

async function runRefresh(
  cookies: readonly CookieValue[],
  refreshToken: string,
): Promise<Refreshed> {
  const { auth, writes, call } = client(withoutSession(cookies));
  const result = await call(
    auth.refreshSession({ refresh_token: refreshToken }),
  );
  if ("unavailable" in result) throw new AuthUnavailable();
  const { data, error } = result;
  if (error) {
    if (isDependencyFailure(error)) throw new AuthUnavailable();
    if (
      ENDED_ON_REFRESH.has(error.code ?? "") ||
      isAuthSessionMissingError(error)
    ) {
      return { kind: "Ended" };
    }
    return unexpected("refresh", error);
  }
  const successor = applyWrites(cookies, writes);
  const session = readSession(successor);
  if (!data?.session || session.state !== "active" || writes.length === 0) {
    // justify-defect: success must publish a live successor before anyone
    // proceeds as the viewer.
    throw new Error("Supabase refresh did not produce an active session");
  }
  return {
    kind: "Refreshed",
    accessToken: session.accessToken,
    cookies: successor,
    writes,
  };
}

// password and email-link operations. the tables are the provider codes each
// operation can reach; their outcomes are what its form renders.

export type SignInOutcome =
  "SignedIn" | "InvalidCredentials" | "RateLimited" | "ServiceUnavailable";
export type RecoveryOutcome =
  "Requested" | "RateLimited" | "ServiceUnavailable";
export type UpdateOutcome =
  | "Saved"
  | "PolicyRejected"
  | "SessionEnded"
  | "RateLimited"
  | "ServiceUnavailable";
export type ConfirmOutcome =
  "Confirmed" | "InvalidOrExpired" | "RateLimited" | "ServiceUnavailable";
export type EmailChangeOutcome = "Sent" | "InUse" | "Failed" | "SessionEnded";

const SIGN_IN: Record<string, SignInOutcome> = {
  invalid_credentials: "InvalidCredentials",
  email_address_invalid: "InvalidCredentials",
  email_not_confirmed: "InvalidCredentials",
  user_banned: "InvalidCredentials",
  user_not_found: "InvalidCredentials",
  validation_failed: "InvalidCredentials",
  over_request_rate_limit: "RateLimited",
  request_timeout: "ServiceUnavailable",
  unexpected_failure: "ServiceUnavailable",
};

export async function signInWithPassword(
  cookies: readonly CookieValue[],
  email: string,
  password: string,
): Promise<{ outcome: SignInOutcome; writes: readonly CookieWrite[] }> {
  const { auth, writes, call } = client(withoutSession(cookies));
  const result = await call(
    auth.signInWithPassword({ email: email.trim().toLowerCase(), password }),
  );
  if ("unavailable" in result) return { outcome: "ServiceUnavailable", writes };
  const { data, error } = result;
  if (error) {
    return {
      outcome:
        SIGN_IN[error.code ?? ""] ?? unexpected("password sign-in", error),
      writes,
    };
  }
  if (!data?.session) {
    throw new Error("Supabase password sign-in returned no session");
  }
  return { outcome: "SignedIn", writes };
}

// every account-dependent failure answers like an unknown address (no
// enumeration), a gateway 5xx too: it only follows account-specific work. the
// pkce verifier the sdk mints here is unused by the token_hash email
// template, so nothing is published.
const RECOVERY_REQUESTED = new Set([
  "email_address_invalid",
  "email_address_not_authorized",
  "email_not_confirmed",
  "over_email_send_rate_limit",
  "user_banned",
  "user_not_found",
  "validation_failed",
  "request_timeout",
  "unexpected_failure",
]);

export async function requestRecovery(email: string): Promise<RecoveryOutcome> {
  const { auth, call } = client([]);
  const result = await call(
    auth.resetPasswordForEmail(email.trim().toLowerCase()),
  );
  if ("unavailable" in result) {
    return result.unavailable >= 500 ? "Requested" : "ServiceUnavailable";
  }
  const { error } = result;
  if (!error || RECOVERY_REQUESTED.has(error.code ?? "")) return "Requested";
  if (error.code === "over_request_rate_limit") return "RateLimited";
  return unexpected("password recovery", error);
}

const UPDATE: Record<string, UpdateOutcome> = {
  same_password: "Saved",
  over_request_rate_limit: "RateLimited",
  conflict: "ServiceUnavailable",
  request_timeout: "ServiceUnavailable",
  unexpected_failure: "ServiceUnavailable",
};

// `cookies` must be live (lib/auth/session.ts liveSession).
export async function updatePassword(
  cookies: readonly CookieValue[],
  password: string,
): Promise<{ outcome: UpdateOutcome; writes: readonly CookieWrite[] }> {
  const { auth, writes, call } = client(cookies);
  const result = await call(auth.updateUser({ password }));
  if ("unavailable" in result) return { outcome: "ServiceUnavailable", writes };
  const { data, error } = result;
  if (!error) {
    if (!data?.user?.id) {
      throw new Error("Supabase password update returned no user");
    }
    return { outcome: "Saved", writes };
  }
  if (endedAtProvider(error)) return { outcome: "SessionEnded", writes };
  if (isAuthWeakPasswordError(error)) {
    // the configured policy is length only: any other reason is drift.
    if (error.reasons.join() !== "length") {
      throw new Error("Unexpected Supabase password policy reasons");
    }
    return { outcome: "PolicyRejected", writes };
  }
  return {
    outcome: UPDATE[error.code ?? ""] ?? unexpected("password update", error),
    writes,
  };
}

const CONFIRM: Record<string, ConfirmOutcome> = {
  otp_expired: "InvalidOrExpired",
  user_banned: "InvalidOrExpired",
  user_not_found: "InvalidOrExpired",
  validation_failed: "InvalidOrExpired",
  over_request_rate_limit: "RateLimited",
  request_timeout: "ServiceUnavailable",
  unexpected_failure: "ServiceUnavailable",
};

export async function confirmEmailLink(
  cookies: readonly CookieValue[],
  purpose: "invite" | "recovery",
  tokenHash: string,
): Promise<{ outcome: ConfirmOutcome; writes: readonly CookieWrite[] }> {
  const { auth, writes, call } = client(withoutSession(cookies));
  const result = await call(
    auth.verifyOtp({ token_hash: tokenHash, type: purpose }),
  );
  if ("unavailable" in result) return { outcome: "ServiceUnavailable", writes };
  const { data, error } = result;
  if (!error) {
    if (!data?.session) {
      throw new Error(`Supabase ${purpose} confirmation returned no session`);
    }
    return { outcome: "Confirmed", writes };
  }
  // an invitation that no longer exists is an expired link; for a recovery
  // link it is drift.
  if (error.code === "invite_not_found" && purpose === "invite") {
    return { outcome: "InvalidOrExpired", writes };
  }
  return {
    outcome:
      CONFIRM[error.code ?? ""] ?? unexpected(`${purpose} confirmation`, error),
    writes,
  };
}

const EMAIL_CHANGE: Record<string, EmailChangeOutcome> = {
  email_exists: "InUse",
  email_conflict_identity_not_deletable: "InUse",
  email_address_invalid: "Failed",
  email_address_not_authorized: "Failed",
  over_email_send_rate_limit: "Failed",
  over_request_rate_limit: "Failed",
  request_timeout: "Failed",
  unexpected_failure: "Failed",
  validation_failed: "Failed",
};

// `cookies` must be live. the writes carry the pkce verifier /auth/callback
// exchanges the confirmation's code with (in this browser).
export async function changeEmail(
  cookies: readonly CookieValue[],
  email: string,
  redirectTo: string,
): Promise<{ outcome: EmailChangeOutcome; writes: readonly CookieWrite[] }> {
  const { auth, writes, call } = client(cookies);
  const result = await call(
    auth.updateUser({ email }, { emailRedirectTo: redirectTo }),
  );
  if ("unavailable" in result) return { outcome: "Failed", writes };
  const { error } = result;
  if (error) {
    if (endedAtProvider(error)) return { outcome: "SessionEnded", writes };
    const outcome = EMAIL_CHANGE[error.code ?? ""];
    return { outcome: outcome ?? unexpected("email update", error), writes };
  }
  // auth-js (2.108.2 _saveSession) deletes the pkce verifier it has just
  // stored for this change when it saves the updated session; the
  // confirmation's code is exchanged with it, so the deletion is dropped.
  const kept = writes.filter(
    (w) => !(w.name.endsWith("-code-verifier") && w.options?.maxAge === 0),
  );
  return { outcome: "Sent", writes: kept };
}

// oauth and session installation: every failure is one public outcome per
// caller, so these answer null rather than a kind.

// link mode adds an identity to the live session; sign-in starts clean. the
// writes carry the pkce verifier /auth/callback needs.
export async function startOAuth(
  cookies: readonly CookieValue[],
  provider: OAuthProvider,
  mode: "signin" | "link",
  redirectTo: string,
): Promise<{ url: string | null; writes: readonly CookieWrite[] }> {
  const { auth, writes, call } = client(
    mode === "link" ? cookies : withoutSession(cookies),
  );
  const options = { redirectTo };
  const result = await call(
    mode === "link"
      ? auth.linkIdentity({ provider, options })
      : auth.signInWithOAuth({ provider, options }),
  );
  const url =
    "unavailable" in result || result.error ? null : (result.data?.url ?? null);
  return { url, writes };
}

async function establish(
  cookies: readonly CookieValue[],
  operation: (auth: ReturnType<typeof client>["auth"]) => Promise<{
    data: { session: { access_token: string; refresh_token: string } | null };
    error: AuthError | null;
  }>,
): Promise<{ tokens: Tokens | null; writes: readonly CookieWrite[] }> {
  const { auth, writes, call } = client(withoutSession(cookies));
  const result = await call(operation(auth));
  const session =
    "unavailable" in result || result.error ? null : result.data?.session;
  return {
    tokens: session
      ? {
          accessToken: session.access_token,
          refreshToken: session.refresh_token,
        }
      : null,
    writes,
  };
}

export const exchangeCode = (cookies: readonly CookieValue[], code: string) =>
  establish(cookies, (auth) => auth.exchangeCodeForSession(code));

export const installSession = (
  cookies: readonly CookieValue[],
  tokens: Tokens,
) =>
  establish(cookies, (auth) =>
    auth.setSession({
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
    }),
  );

export const signInWithGoogleIdToken = (
  cookies: readonly CookieValue[],
  idToken: string,
  nonce: string,
) =>
  establish(cookies, (auth) =>
    auth.signInWithIdToken({ provider: "google", token: idToken, nonce }),
  );

// local scope: this browser's session only. throws on failure; sign-out logs
// it and clears locally anyway.
export async function revoke(accessToken: string): Promise<void> {
  const { url, anonKey } = getEnv().supabase;
  const response = await fetch(
    `${url.replace(/\/$/, "")}/auth/v1/logout?scope=local`,
    {
      method: "POST",
      headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(OPERATION_DEADLINE_MS),
    },
  );
  if (!response.ok && ![401, 403, 404].includes(response.status)) {
    throw new Error(`Supabase sign-out answered ${response.status}`);
  }
}

// identities: google and github only (the email identity is not one a viewer
// links or unlinks). any failure but an ended session is one outcome.
const identityFailure = (
  result: { unavailable: number } | { error: AuthError },
) =>
  "error" in result && endedAtProvider(result.error)
    ? "SessionEnded"
    : "Failed";

// `cookies` must be live.
export async function listIdentities(
  cookies: readonly CookieValue[],
): Promise<
  (
    | { outcome: "Listed"; identities: LinkedIdentity[] }
    | { outcome: "Failed" | "SessionEnded" }
  ) & { writes: readonly CookieWrite[] }
> {
  const { auth, writes, call } = client(cookies);
  const result = await call(auth.getUserIdentities());
  if ("unavailable" in result || result.error) {
    return { outcome: identityFailure(result), writes };
  }
  const identities = result.data.identities.flatMap((row) => {
    const { provider, identity_data: data } = row;
    if (!isOAuthProvider(provider)) return [];
    const identity: LinkedIdentity = {
      id: row.identity_id,
      provider,
      email: typeof data?.email === "string" ? data.email : null,
      createdAt: row.created_at ?? null,
    };
    return [identity];
  });
  return { outcome: "Listed", identities, writes };
}

// `cookies` must be live. the last remaining identity is never unlinked.
export async function unlinkIdentity(
  cookies: readonly CookieValue[],
  identityId: string,
  provider: string,
): Promise<{
  outcome: "Unlinked" | "Failed" | "SessionEnded";
  writes: readonly CookieWrite[];
}> {
  const { auth, writes, call } = client(cookies);
  const listed = await call(auth.getUserIdentities());
  if ("unavailable" in listed || listed.error) {
    return { outcome: identityFailure(listed), writes };
  }
  const rows = listed.data.identities.filter((row) =>
    isOAuthProvider(row.provider),
  );
  const match = rows.find(
    (row) => row.identity_id === identityId && row.provider === provider,
  );
  if (!match || rows.length < 2) return { outcome: "Failed", writes };
  const unlinked = await call(auth.unlinkIdentity(match));
  if ("unavailable" in unlinked || unlinked.error) {
    return { outcome: identityFailure(unlinked), writes };
  }
  return { outcome: "Unlinked", writes };
}
