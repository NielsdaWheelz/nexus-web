// Workspace hrefs are same-origin `pathname+search+hash`. Isomorphic: the
// server resolves against http://localhost, the browser against its origin.
import { formatLocalDateInTimeZone } from "@/lib/localDate";
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

/**
 * The canonical href, or null when not same-origin, over 4096 chars, or
 * protocol-relative once dot segments collapse (`/.//host` names another origin).
 */
export function normalizeWorkspaceHref(href: string): string | null {
  const url = parseWorkspaceHref(href);
  if (!url || url.pathname.startsWith("//")) return null;
  if (url.pathname === "/conversations/new" || url.pathname === "/pages/new") url.search = "";
  const normalized = `${url.pathname}${url.search}${url.hash}`;
  return normalized.length <= MAX_WORKSPACE_HREF_LENGTH ? normalized : null;
}

/** Bare `/daily` is entry-only: today's page in the account zone, never stored. */
export function resolveTodayHref(href: string, timeZone: string): string {
  return parseWorkspaceHref(href)?.pathname === "/daily"
    ? `/daily/${formatLocalDateInTimeZone(new Date(), timeZone)}`
    : href;
}
