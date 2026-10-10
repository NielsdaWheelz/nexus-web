// Workspace hrefs are same-origin `pathname+search+hash`. Isomorphic: the
// server resolves against http://localhost, the browser against its origin.
import { APP_AUTHENTICATED_HOME_HREF } from "@/lib/routes/defaults";

export const WORKSPACE_DEFAULT_FALLBACK_HREF = APP_AUTHENTICATED_HOME_HREF;
export const MAX_WORKSPACE_HREF_LENGTH = 4096;

export function parseWorkspaceHref(href: string): URL | null {
  const origin =
    typeof window === "undefined" ? "http://localhost" : window.location.origin;
  if (!href.trim()) return null;
  try {
    const url = new URL(href, origin);
    return url.origin === origin && /^https?:$/.test(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

/** The canonical href, or null when not same-origin or over 4096 chars. */
export function normalizeWorkspaceHref(href: string): string | null {
  const url = parseWorkspaceHref(href);
  const normalized = url && `${url.pathname}${url.search}${url.hash}`;
  return normalized && normalized.length <= MAX_WORKSPACE_HREF_LENGTH
    ? normalized
    : null;
}
