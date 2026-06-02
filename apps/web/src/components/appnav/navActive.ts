/**
 * Resolve the single active destination id for a pathname.
 *
 * Exact matches win over prefix matches, so a pinned `/pages/x` (exact) beats
 * the Notes `/pages/` prefix. Within a pass, the first match in `destinations`
 * order wins — callers list pins before sections before the account so a pin
 * outranks a section claiming the same path. Defaults: exact = [href], no prefix.
 */
export function resolveActiveDestinationId(
  pathname: string,
  destinations: {
    id: string;
    href: string;
    match?: { exact?: string[]; prefix?: string[] };
  }[],
): string | null {
  for (const d of destinations) {
    if ((d.match?.exact ?? [d.href]).includes(pathname)) return d.id;
  }
  for (const d of destinations) {
    if ((d.match?.prefix ?? []).some((p) => pathname.startsWith(p))) return d.id;
  }
  return null;
}
