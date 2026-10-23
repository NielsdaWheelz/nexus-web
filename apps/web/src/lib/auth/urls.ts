// isomorphic (no env, no secrets): the return-target grammar, the oauth
// providers, the relative auth paths, the android deep links and the header
// middleware stamps for server components. absolute urls are made on APP_PUBLIC_URL by their callers
// (lib/auth/session.ts redirectTo, the oauth and email-change callbacks).
import { APP_AUTHENTICATED_HOME_HREF } from "@/lib/routes/defaults";

export type ReturnTarget = string & { readonly __returnTarget: unique symbol };
export const OAUTH_PROVIDERS = ["google", "github"] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];
// query feedback; ended-session feedback comes from its cookie, never the url.
export interface HandoffContext { readonly challenge: string }
export function parseHandoffContext(flow: string | null | undefined, hc: string | null | undefined): HandoffContext | null {
  return flow === "handoff" && typeof hc === "string" && /^[a-f0-9]{64}$/.test(hc) ? { challenge: hc } : null;
}

export type LoginError = "oauth_start_failed" | "sign_in_failed";

export const DEFAULT_RETURN_TARGET =
  APP_AUTHENTICATED_HOME_HREF as ReturnTarget;
export const PROVIDER_NAMES: Record<OAuthProvider, string> = {
  google: "Google",
  github: "GitHub",
};
export const isOAuthProvider = (value: unknown): value is OAuthProvider =>
  OAUTH_PROVIDERS.includes(value as OAuthProvider);

// the pathname and search of a protected request: server components cannot
// see the url. the hash never reaches the server.
export const REQUEST_PATH_HEADER = "x-nexus-request-path";
// routing context only: middleware overwrites this; it grants no identity.
export const REQUEST_METHOD_HEADER = "x-nexus-request-method";

export function firstParam(
  value: string | string[] | undefined,
): string | null {
  return (Array.isArray(value) ? value[0] : value) ?? null;
}

// a local path that is not an auth surface; anything else is the default home.
export function parseReturnTarget(
  raw: string | null | undefined,
): ReturnTarget {
  const value = raw?.trim() ?? "";
  if (!value.startsWith("/") || value.startsWith("//")) {
    return DEFAULT_RETURN_TARGET;
  }
  let url: URL;
  try {
    url = new URL(value, "http://localhost");
  } catch {
    return DEFAULT_RETURN_TARGET;
  }
  if (url.searchParams.has("_rsc")) {
    // remove transport pairs without reserializing the other query bytes.
    url.search = url.search.slice(1)
      .split("&")
      .filter((pair) => !new URLSearchParams(pair).has("_rsc"))
      .join("&");
  }
  const target = `${url.pathname}${url.search}${url.hash}`;
  const authPath =
    url.pathname === "/login" ||
    url.pathname === "/auth" ||
    url.pathname.startsWith("/auth/");
  if (
    url.origin !== "http://localhost" ||
    target.startsWith("//") ||
    authPath
  ) {
    return DEFAULT_RETURN_TARGET;
  }
  return target as ReturnTarget;
}

// `params` in order, then `next` unless the target is the default.
function withNext(
  base: string,
  target: ReturnTarget,
  params: Record<string, string> = {},
): string {
  const query = new URLSearchParams(params);
  if (target !== DEFAULT_RETURN_TARGET) query.set("next", target);
  const search = query.toString();
  return search ? `${base}?${search}` : base;
}

export const loginPath = (target: ReturnTarget, error?: LoginError, handoff: HandoffContext | null = null) =>
  withNext("/login", target, { ...(error ? { error } : {}), ...(handoff ? { flow: "handoff", hc: handoff.challenge } : {}) });

export function expectedAccountPath(path: string, expectedAccountId: string | null): string {
  if (expectedAccountId === null) return path;
  const url = new URL(path, "http://localhost");
  url.searchParams.set("expected_account_id", expectedAccountId);
  return `${url.pathname}${url.search}`;
}

export const switchBrowserAccountPath = (target: ReturnTarget) =>
  withNext("/login", target, { switch_account: "1" });

export const unavailablePath = (target: ReturnTarget) =>
  withNext("/auth/session/unavailable", target);

// handoff: the android shell's challenge (hex sha-256 of its verifier). email:
// an email-change confirmation, which may open in a browser that holds no
// pkce verifier (the provider has applied the change by then).
export const callbackPath = (
  target: ReturnTarget,
  flow?: { handoff: string } | "email",
) =>
  withNext(
    "/auth/callback",
    target,
    flow === "email"
      ? { flow: "email" }
      : flow
        ? { flow: "handoff", hc: flow.handoff }
        : {},
  );

// sign-in returns to `target`. link mode adds an identity to the live session
// and always returns to /settings/identities, so it carries no target.
export const oauthPath = (
  provider: OAuthProvider,
  target: ReturnTarget | "link",
  handoff: HandoffContext | null = null,
) =>
  target === "link"
    ? withNext("/auth/oauth", DEFAULT_RETURN_TARGET, { mode: "link", provider })
    : withNext("/auth/oauth", target, { provider, ...(handoff ? { flow: "handoff", hc: handoff.challenge } : {}) });

export const savedPasswordPath = (target: ReturnTarget, expectedAccountId: string | null = null) =>
  expectedAccountPath(withNext("/account/password", target, { saved: "1" }), expectedAccountId);

export const handoffDeepLink = (
  outcome: { code: string } | { error: string },
  target: ReturnTarget,
  handoff: HandoffContext,
) => withNext("nexus://auth/handoff", target, { ...outcome, hc: handoff.challenge });

export const nativeGoogleDeepLink = (target: ReturnTarget, handoff: HandoffContext) =>
  withNext("nexus://auth/native", target, { provider: "google", hc: handoff.challenge });
