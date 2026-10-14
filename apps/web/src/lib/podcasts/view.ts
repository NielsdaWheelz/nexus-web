/** Preserve unrelated pane-url keys; null removes a domain view parameter. */
export function podcastViewHref(
  basePath: string,
  current: URLSearchParams,
  changes: Readonly<Record<string, string | null>>,
): string {
  const next = new URLSearchParams(current);
  for (const [param, value] of Object.entries(changes)) {
    if (value === null) next.delete(param);
    else next.set(param, value);
  }
  const query = next.toString();
  return query ? `${basePath}?${query}` : basePath;
}
