export interface WebOrigin {
  readonly origin: string;
  readonly protocol: "http:" | "https:";
  readonly hostname: string;
  readonly host: string;
  readonly isLocalhost: boolean;
}

export function parseWebOrigin(value: string): WebOrigin | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    if (url.pathname !== "/" || url.search || url.hash) return null;
    const hostname = url.hostname.toLowerCase();
    return {
      origin: url.origin,
      protocol: url.protocol,
      hostname,
      host: url.host.toLowerCase(),
      isLocalhost:
        hostname === "localhost" ||
        hostname === "127.0.0.1" ||
        hostname === "::1" ||
        hostname === "[::1]",
    };
  } catch {
    return null;
  }
}

export function parseWebOriginList(rawValue: string | undefined): {
  origins: WebOrigin[];
  invalidValues: string[];
} {
  const origins = new Map<string, WebOrigin>();
  const invalidValues: string[] = [];

  for (const rawEntry of (rawValue ?? "").split(",")) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    const origin = parseWebOrigin(entry);
    if (origin) origins.set(origin.origin, origin);
    else invalidValues.push(entry);
  }

  return { origins: [...origins.values()], invalidValues };
}

export function isLocalhostOrigin(origin: string): boolean {
  try {
    const hostname = new URL(origin).hostname.toLowerCase();
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "[::1]"
    );
  } catch {
    return false;
  }
}
