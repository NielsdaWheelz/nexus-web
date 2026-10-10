// isomorphic (no env, no secrets): the return-target grammar, the oauth
// providers, the relative auth paths, the android deep links and the header
// middleware stamps for server components. absolute urls are made on APP_PUBLIC_URL by their callers
// (lib/auth/session.ts redirectTo, the oauth and email-change callbacks).
import { APP_AUTHENTICATED_HOME_HREF } from "@/lib/routes/defaults";

export type ReturnTarget = string & { readonly __returnTarget: unique symbol };
export const OAUTH_PROVIDERS = ["google", "github"] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];
// the only feedback /login renders from its query. "Your session ended." comes
// from the ended-feedback cookie, never from the url.
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

export const loginPath = (target: ReturnTarget, error?: LoginError) =>
  withNext("/login", target, error ? { error } : {});

export const recoverPath = (target: ReturnTarget) =>
  withNext("/auth/session/recover", target);

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
) =>
  target === "link"
    ? withNext("/auth/oauth", DEFAULT_RETURN_TARGET, { mode: "link", provider })
    : withNext("/auth/oauth", target, { provider });

export const savedPasswordPath = (target: ReturnTarget) =>
  withNext("/account/password", target, { saved: "1" });

export const handoffDeepLink = (
  outcome: { code: string } | { error: string },
  target: ReturnTarget,
) => withNext("nexus://auth/handoff", target, outcome);

export const startDeepLink = (provider: OAuthProvider, target: ReturnTarget) =>
  withNext("nexus://auth/start", target, { provider, mode: "signin" });

export const nativeGoogleDeepLink = (target: ReturnTarget) =>
  withNext("nexus://auth/native", target, { provider: "google" });
