// Pure, SSR-safe href helpers (the window reads below are guarded), so both the
// client workspace and the server bootstrap can import them.

import { APP_AUTHENTICATED_HOME_HREF } from "@/lib/routes/defaults";

export const WORKSPACE_DEFAULT_FALLBACK_HREF = APP_AUTHENTICATED_HOME_HREF;

function resolveBaseOrigin(baseOrigin?: string): string {
  if (baseOrigin && baseOrigin.length > 0) {
    return baseOrigin;
  }
  if (
    typeof window !== "undefined" &&
    window.location.origin &&
    window.location.origin !== "null"
  ) {
    return window.location.origin;
  }
  return "http://localhost";
}

export function parseWorkspaceHref(
  href: string,
  options?: { baseOrigin?: string }
): URL | null {
  if (typeof href !== "string" || href.trim().length === 0) {
    return null;
  }
  const baseOrigin = resolveBaseOrigin(options?.baseOrigin);
  try {
    const parsed = new URL(href, baseOrigin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    if (parsed.origin !== baseOrigin) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function normalizeWorkspaceHref(
  href: string,
  options?: { baseOrigin?: string }
): string | null {
  const parsed = parseWorkspaceHref(href, options);
  if (!parsed) {
    return null;
  }
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}
