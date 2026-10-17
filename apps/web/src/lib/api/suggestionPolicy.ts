export const SUGGESTIONS_REQUEST_TIMEOUT_MS = 10_000;

export function isSuggestionJsonPath(path: string): boolean {
  return /^\/(?:lectern|libraries\/[^/]+)\/suggestions(?:\/(?:view|refresh))?$/.test(
    path.split("?", 1)[0],
  );
}
