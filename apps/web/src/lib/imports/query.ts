/** Imports keeps only its selected record in the url. Restoring it opens no surface. */

export interface ImportsUrlState {
  readonly selected?: string;
}

/** One segment: a work, upload, or subscription import, never another route. */
const IMPORT_REF = /^(upload|media|opml):[^/]+$/;

export function decodeImportsUrl(params: URLSearchParams): ImportsUrlState {
  const selected = params.get("selected");
  return selected !== null && IMPORT_REF.test(selected) ? { selected } : {};
}

export function encodeImportsUrl(state: ImportsUrlState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.selected !== undefined) params.set("selected", state.selected);
  return params;
}
