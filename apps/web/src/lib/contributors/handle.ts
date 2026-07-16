// Contributor handles are stable outward short aliases (see
// docs/cutovers/lightweight-author-deduplication-hard-cutover.md §2.3): 3..80
// lowercase ASCII characters matching CONTRIBUTOR_HANDLE_RE, excluding the
// reserved collection segments the `/authors/{handle}` route space shadows.
// Mirrors the Python twin `parse_contributor_handle` /
// `try_parse_contributor_handle` in nexus/services/contributor_taxonomy.py —
// every Python and TypeScript boundary uses this brand, never a plain string.

export type ContributorHandle = string & {
  readonly __contributorHandle: unique symbol;
};

export const RESERVED_CONTRIBUTOR_HANDLE_SEGMENTS: ReadonlySet<string> = new Set([
  "directory",
  "reconciliation-candidates",
]);

export const CONTRIBUTOR_HANDLE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const MIN_CONTRIBUTOR_HANDLE_LENGTH = 3;
const MAX_CONTRIBUTOR_HANDLE_LENGTH = 80;

function isCanonicalContributorHandle(value: string): boolean {
  return (
    value.length >= MIN_CONTRIBUTOR_HANDLE_LENGTH &&
    value.length <= MAX_CONTRIBUTOR_HANDLE_LENGTH &&
    CONTRIBUTOR_HANDLE_RE.test(value) &&
    !RESERVED_CONTRIBUTOR_HANDLE_SEGMENTS.has(value)
  );
}

/** Validate a wire-text handle at ingress; throws on anything non-canonical. */
export function parseContributorHandle(value: string): ContributorHandle {
  if (!isCanonicalContributorHandle(value)) {
    throw new Error(`invalid contributor handle: ${JSON.stringify(value)}`);
  }
  return value as ContributorHandle;
}

/** Same validation as parseContributorHandle, but returns null instead of throwing. */
export function tryParseContributorHandle(value: string): ContributorHandle | null {
  return isCanonicalContributorHandle(value) ? (value as ContributorHandle) : null;
}

/** Requires the value to already be canonical; defects (throws) otherwise. */
export function assumeContributorHandle(value: string): ContributorHandle {
  if (!isCanonicalContributorHandle(value)) {
    throw new Error(`non-canonical contributor handle: ${JSON.stringify(value)}`);
  }
  return value as ContributorHandle;
}
