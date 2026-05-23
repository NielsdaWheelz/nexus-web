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

function getForwardedOrigin(request: Request): string | null {
  const forwardedHost = getFirstHeaderValue(request.headers.get("x-forwarded-host"));
  if (!forwardedHost) {
    return null;
  }

  const forwardedProto =
    getFirstHeaderValue(request.headers.get("x-forwarded-proto")) ?? "https";
  return normalizeOrigin(`${forwardedProto}://${forwardedHost}`);
}

export function resolveCallbackRedirectOrigin(
  request: Request,
  requestUrl: URL
): string {
  const allowlistedOrigins = parseAllowlistedOrigins(
    process.env[AUTH_ALLOWED_REDIRECT_ORIGINS]
  );
  const trustedProxyOrigins = parseAllowlistedOrigins(
    process.env[AUTH_TRUSTED_PROXY_ORIGINS]
  );
  const requestOrigin = requestUrl.origin;

  if (allowlistedOrigins.length === 0) {
    if (isLocalOrigin(requestOrigin)) {
      return requestOrigin;
    }

    throw new Error(
      `${AUTH_ALLOWED_REDIRECT_ORIGINS} must be configured for non-local auth callbacks`
    );
  }

  if (allowlistedOrigins.includes(requestOrigin)) {
    return requestOrigin;
  }

  const forwardedOrigin = getForwardedOrigin(request);
  if (
    forwardedOrigin &&
    allowlistedOrigins.includes(forwardedOrigin) &&
    trustedProxyOrigins.includes(requestOrigin)
  ) {
    return forwardedOrigin;
  }

  throw new Error(`${AUTH_ALLOWED_REDIRECT_ORIGINS} rejected auth callback origin`);
}
