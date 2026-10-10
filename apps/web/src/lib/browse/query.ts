// The browse url grammar (q, kind, source, sort=Newest) and the fixed plan of
// eight sections it fans out to. The server validates every value it receives.

import type { BrowseKind, BrowseSort, BrowseSource } from "@/lib/browse/api";

export interface BrowseQuery {
  readonly text: string;
  readonly kind: "All" | BrowseKind;
  readonly source: BrowseSource | null;
  readonly sort: BrowseSort;
}

export interface BrowseSection {
  readonly kind: BrowseKind;
  readonly source: BrowseSource;
  readonly sort: BrowseSort;
}

export const BROWSE_KINDS: readonly BrowseKind[] = [
  "Pdf",
  "Epub",
  "WebArticle",
  "Video",
  "Podcast",
];

export const BROWSE_KIND_LABELS: Readonly<Record<BrowseKind, string>> = {
  Pdf: "PDF",
  Epub: "EPUB",
  WebArticle: "Web Article",
  Video: "Video",
  Podcast: "Podcast",
};

export const BROWSE_SOURCE_LABELS: Readonly<Record<BrowseSource, string>> = {
  Nexus: "Nexus",
  ProjectGutenberg: "Project Gutenberg",
  Brave: "Brave",
  YouTube: "YouTube",
  PodcastIndex: "Podcast Index",
};

const PLAN: readonly (readonly [BrowseKind, BrowseSource])[] = [
  ["Pdf", "Nexus"],
  ["Epub", "Nexus"],
  ["Epub", "ProjectGutenberg"],
  ["WebArticle", "Nexus"],
  ["WebArticle", "Brave"],
  ["Video", "Nexus"],
  ["Video", "YouTube"],
  ["Podcast", "PodcastIndex"],
];

/** The planned sections a query names, in plan order. */
export function browseSections(query: BrowseQuery): readonly BrowseSection[] {
  return PLAN.flatMap(([kind, source]) =>
    (query.kind === "All" || query.kind === kind) &&
    (query.source === null || query.source === source)
      ? [
          {
            kind,
            source,
            sort:
              kind === "Video" && source === "YouTube"
                ? query.sort
                : "Relevance",
          },
        ]
      : [],
  );
}

export function browseSourcesFor(
  kind: "All" | BrowseKind,
): readonly BrowseSource[] {
  return PLAN.filter(([planned]) => planned === kind).map(
    ([, source]) => source,
  );
}

/** Null iff `kind` or `source` names no planned section. */
export function readBrowseQuery(params: URLSearchParams): BrowseQuery | null {
  const kind = params.get("kind") ?? "All";
  const source = params.get("source");
  const named = PLAN.find(
    ([plannedKind, plannedSource]) =>
      (kind === "All" || kind === plannedKind) &&
      (source === null || source === plannedSource),
  );
  if (named === undefined) return null;
  return {
    text: params.get("q") ?? "",
    kind: kind === "All" ? "All" : named[0],
    source: source === null ? null : named[1],
    sort: params.get("sort") === "Newest" ? "Newest" : "Relevance",
  };
}

export function browseHref(query: BrowseQuery): string {
  const params = new URLSearchParams();
  if (query.text) params.set("q", query.text);
  if (query.kind !== "All") params.set("kind", query.kind);
  if (query.source !== null) params.set("source", query.source);
  if (query.sort === "Newest") params.set("sort", "Newest");
  const suffix = params.toString();
  return suffix ? `/browse?${suffix}` : "/browse";
}

/** A normalised draft the server would refuse: over 200 code points or C0/C1. */
export function browseDraftInvalid(draft: string): boolean {
  const control = /[\u0000-\u001f\u007f-\u009f]/u;
  return Array.from(draft).length > 200 || control.test(draft);
}
