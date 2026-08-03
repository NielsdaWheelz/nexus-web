import type { BrowseKind, BrowseSort, BrowseSource } from "./contract";

export const BROWSE_KINDS = [
  "All",
  "Pdf",
  "Epub",
  "WebArticle",
  "Video",
  "Podcast",
] as const satisfies readonly ["All", ...BrowseKind[]];

export const BROWSE_SOURCES = [
  "Nexus",
  "ProjectGutenberg",
  "Brave",
  "YouTube",
  "PodcastIndex",
] as const satisfies readonly BrowseSource[];

export type BrowseQueryKind = "All" | BrowseKind;
export type BrowseQuerySource = BrowseSource;
export type BrowseQuerySort = BrowseSort;

export interface BrowsePlanSelection {
  readonly kind: BrowseQueryKind;
  readonly source: BrowseQuerySource | null;
  readonly sort: BrowseQuerySort;
}

export interface BrowseSectionIdentity {
  readonly kind: BrowseKind;
  readonly source: BrowseSource;
  readonly sort: BrowseSort;
}

export interface BrowseResultChapter {
  readonly kind: BrowseKind;
  readonly sections: readonly BrowseSectionIdentity[];
}

export const BROWSE_SECTION_PLAN: readonly BrowseSectionIdentity[] = [
  { kind: "Pdf", source: "Nexus", sort: "Relevance" },
  { kind: "Epub", source: "Nexus", sort: "Relevance" },
  { kind: "Epub", source: "ProjectGutenberg", sort: "Relevance" },
  { kind: "WebArticle", source: "Nexus", sort: "Relevance" },
  { kind: "WebArticle", source: "Brave", sort: "Relevance" },
  { kind: "Video", source: "Nexus", sort: "Relevance" },
  { kind: "Video", source: "YouTube", sort: "Relevance" },
  { kind: "Podcast", source: "PodcastIndex", sort: "Relevance" },
];

export function browseSourcesForKind(
  kind: BrowseQueryKind,
): readonly BrowseQuerySource[] {
  if (kind === "All") return [];
  return BROWSE_SECTION_PLAN.filter((section) => section.kind === kind).map(
    (section) => section.source,
  );
}

export function browseResultChapters(
  selection: BrowsePlanSelection,
): readonly BrowseResultChapter[] {
  return BROWSE_KINDS.flatMap((kind) => {
    if (kind === "All" || (selection.kind !== "All" && selection.kind !== kind)) {
      return [];
    }
    const sections = BROWSE_SECTION_PLAN.filter(
      (section) =>
        section.kind === kind &&
        (selection.source === null || section.source === selection.source),
    ).map((section) =>
      section.kind === "Video" && section.source === "YouTube"
        ? { ...section, sort: selection.sort }
        : section,
    );
    return sections.length === 0 ? [] : [{ kind, sections }];
  });
}

export function browseSectionKey(identity: BrowseSectionIdentity): string {
  return `${identity.kind}:${identity.source}`;
}
