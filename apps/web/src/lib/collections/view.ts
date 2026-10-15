/** Url-owned view parameter changes; null removes a parameter. */
export type ViewChanges = Readonly<Record<string, string | null>>;

/** Preserve unrelated pane-url keys; null removes a domain view parameter. */
export function viewHref(
  basePath: string,
  current: URLSearchParams,
  changes: ViewChanges,
): string {
  const next = new URLSearchParams(current);
  for (const [param, value] of Object.entries(changes)) {
    if (value === null) next.delete(param);
    else next.set(param, value);
  }
  const query = next.toString();
  return query ? `${basePath}?${query}` : basePath;
}
