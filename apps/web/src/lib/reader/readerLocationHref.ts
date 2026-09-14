/**
 * The one owner of media reader href construction and coarse-query repair.
 *
 * URL contract: the stable entry is `/media/:id`. Query fields `loc` and
 * `fragment` are coarse navigation intent, not progress storage — the
 * canonical cursor never projects into the URL. `apparatus`, other
 * unrelated query state, and the hash are feature-owned and always
 * preserved by repair. EPUB relative-document resolution stays
 * format-local in `epubHelpers.ts`.
 */

const PANE_HREF_BASE = "https://pane.local";

export type ReaderLocationTarget =
  | { loc: string; fragmentId?: string }
  | { fragmentId: string; loc?: never };

export function buildReaderLocationHref(
  mediaId: string,
  target: ReaderLocationTarget,
): string {
  const params = new URLSearchParams();
  if (target.loc) {
    params.set("loc", target.loc);
  }
  if (target.fragmentId) {
    params.set("fragment", target.fragmentId);
  }
  const query = params.toString();
  return query ? `/media/${mediaId}?${query}` : `/media/${mediaId}`;
}

/**
 * Remove only the coarse reader query fields (`loc`, `fragment`) from a
 * pane-relative href. Used when canonical state supersedes a cold coarse
 * query (pane-local replace) and for canonical reader-location composition; a
 * fully bare href would silently discard explicit feature intent.
 */
export function stripCoarseReaderQuery(href: string): string {
  const url = new URL(href, PANE_HREF_BASE);
  url.searchParams.delete("loc");
  url.searchParams.delete("fragment");
  const query = url.searchParams.toString();
  return `${url.pathname}${query ? `?${query}` : ""}${url.hash}`;
}

/** Whether an href carries either coarse reader query field. */
export function hasCoarseReaderQuery(href: string): boolean {
  const url = new URL(href, PANE_HREF_BASE);
  return url.searchParams.has("loc") || url.searchParams.has("fragment");
}
