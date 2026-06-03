const AUTH_ALLOWED_REDIRECT_ORIGINS = "AUTH_ALLOWED_REDIRECT_ORIGINS";
const AUTH_TRUSTED_PROXY_ORIGINS = "AUTH_TRUSTED_PROXY_ORIGINS";
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function getFirstHeaderValue(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const first = value.split(",")[0]?.trim();
  return first ? first : null;
}

function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    if (url.username || url.password) {
      return null;
    }
    if (url.pathname !== "/" || url.search || url.hash) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function isLocalOrigin(origin: string): boolean {
  try {
    const hostname = new URL(origin).hostname.toLowerCase();
    return LOCAL_HOSTNAMES.has(hostname);
  } catch {
    return false;
  }
}

function parseAllowlistedOrigins(rawValue: string | undefined): string[] {
  if (!rawValue) {
    return [];
  }

  const parsed = rawValue
    .split(",")
    .map((value) => normalizeOrigin(value.trim()))
    .filter((value): value is string => value !== null);

  return Array.from(new Set(parsed));
}

function getForwardedOrigin(requestHeaders: Headers): string | null {
  const forwardedHost = getFirstHeaderValue(
    requestHeaders.get("x-forwarded-host")
  );
  if (!forwardedHost) {
    return null;
  }

  const forwardedProto =
    getFirstHeaderValue(requestHeaders.get("x-forwarded-proto")) ?? "https";
  return normalizeOrigin(`${forwardedProto}://${forwardedHost}`);
}

function getHostOrigin(requestHeaders: Headers): string | null {
  const host = getFirstHeaderValue(requestHeaders.get("host"));
  if (!host) {
    return null;
  }

  // Direct origin is built from `host` ALONE — never from x-forwarded-*, which
  // is attacker-influenced and gates the forwarded-origin branch. Mirrors the
  // route path (direct origin = requestUrl.origin; forwarded headers consulted
  // only afterwards). The scheme is a deterministic candidate — local hosts get
  // http, everything else https — matched on raw-host prefixes since the host
  // may carry a port or bracketed IPv6 colons. The allowlist (prod) or
  // isLocalOrigin (empty allowlist) is the authority, so a wrong guess fails closed.
  const lowerHost = host.toLowerCase();
  const isLocal =
    lowerHost === "localhost" ||
    lowerHost.startsWith("localhost:") ||
    lowerHost.startsWith("127.0.0.1") ||
    lowerHost.startsWith("[::1]");
  return normalizeOrigin(`${isLocal ? "http" : "https"}://${host}`);
}

function resolveAllowlistedRedirectOrigin(
  directOrigin: string | null,
  forwardedOrigin: string | null
): string {
  const allowlistedOrigins = parseAllowlistedOrigins(
    process.env[AUTH_ALLOWED_REDIRECT_ORIGINS]
  );
  const trustedProxyOrigins = parseAllowlistedOrigins(
    process.env[AUTH_TRUSTED_PROXY_ORIGINS]
  );

  if (allowlistedOrigins.length === 0) {
    if (directOrigin && isLocalOrigin(directOrigin)) {
      return directOrigin;
    }

    throw new Error(
      `${AUTH_ALLOWED_REDIRECT_ORIGINS} must be configured for non-local auth callbacks`
    );
  }

  if (directOrigin && allowlistedOrigins.includes(directOrigin)) {
    return directOrigin;
  }

  if (
    forwardedOrigin &&
    allowlistedOrigins.includes(forwardedOrigin) &&
    directOrigin &&
    trustedProxyOrigins.includes(directOrigin)
  ) {
    return forwardedOrigin;
  }

  throw new Error(`${AUTH_ALLOWED_REDIRECT_ORIGINS} rejected auth callback origin`);
}

export function resolveCallbackRedirectOrigin(
  request: Request,
  requestUrl: URL
): string {
  return resolveAllowlistedRedirectOrigin(
    requestUrl.origin,
    getForwardedOrigin(request.headers)
  );
}

export function resolveServerActionRedirectOrigin(
  requestHeaders: Headers
): string {
  return resolveAllowlistedRedirectOrigin(
    getHostOrigin(requestHeaders),
    getForwardedOrigin(requestHeaders)
  );
}
