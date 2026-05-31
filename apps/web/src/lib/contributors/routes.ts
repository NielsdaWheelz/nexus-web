export function contributorAuthorHref(handle: string): string {
  return `/authors/${encodeURIComponent(handle)}`;
}
