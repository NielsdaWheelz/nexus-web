// origin values in env config (lib/env.ts).
export interface WebOrigin {
  readonly origin: string;
  readonly protocol: "http:" | "https:";
  readonly hostname: string;
  readonly isLocalhost: boolean;
}

// a bare http(s) origin: no credentials, path, query or fragment.
export function parseWebOrigin(value: string): WebOrigin | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.pathname !== "/" || url.search || url.hash) return null;
  const hostname = url.hostname.toLowerCase();
  return {
    origin: url.origin,
    protocol: url.protocol,
    hostname,
    isLocalhost: ["localhost", "127.0.0.1", "[::1]"].includes(hostname),
  };
}

// comma-separated origins, deduplicated; invalid entries are reported, not
// dropped.
export function parseWebOriginList(raw: string | undefined): {
  origins: WebOrigin[];
  invalidValues: string[];
} {
  const origins = new Map<string, WebOrigin>();
  const invalidValues: string[] = [];
  for (const entry of (raw ?? "").split(",").map((part) => part.trim())) {
    if (!entry) continue;
    const origin = parseWebOrigin(entry);
    if (origin) origins.set(origin.origin, origin);
    else invalidValues.push(entry);
  }
  return { origins: [...origins.values()], invalidValues };
}
