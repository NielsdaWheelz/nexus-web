/**
 * Cross-spec route facts for the Playwright harness.
 *
 * This is intentionally a projection of the Web app's route contract rather
 * than an import from apps/web: the E2E package must remain independently
 * type-checkable, while every auth/setup helper should still agree on the one
 * authenticated home.
 */
export const AUTHENTICATED_HOME_PATH = "/lectern";

export function isAuthenticatedHome(url: URL): boolean {
  return url.pathname === AUTHENTICATED_HOME_PATH;
}
