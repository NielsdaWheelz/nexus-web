import {
  parseDiscoveryTargetHandle,
  type DiscoveryTargetHandle,
} from "./contract";

export const BROWSE_KINDS = [
  "All",
  "Pdf",
  "Epub",
  "WebArticle",
  "Video",
  "Podcast",
] as const;
export type BrowseQueryKind = (typeof BROWSE_KINDS)[number];

export const BROWSE_SOURCES = [
  "Nexus",
  "ProjectGutenberg",
  "Brave",
  "YouTube",
  "PodcastIndex",
] as const;
export type BrowseQuerySource = (typeof BROWSE_SOURCES)[number];
export type BrowseQuerySort = "Relevance" | "Newest";

export interface BrowseQuery {
  readonly text: string;
  readonly kind: BrowseQueryKind;
  readonly source: BrowseQuerySource | null;
  readonly sort: BrowseQuerySort;
}

export type BrowseQueryDecode =
  | { readonly kind: "Valid"; readonly query: BrowseQuery }
  | { readonly kind: "Invalid" };

const ALLOWED_KEYS = new Set(["q", "kind", "source", "sort"]);
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;

function hasExactlyOne(
  params: URLSearchParams,
  name: string,
): string | null | undefined {
  const values = params.getAll(name);
  if (values.length === 0) return null;
  if (values.length !== 1) return undefined;
  return values[0]!;
}

function countCodePoints(value: string): number {
  return Array.from(value).length;
}

function applicableSources(kind: BrowseQueryKind): readonly BrowseQuerySource[] {
  switch (kind) {
    case "All":
      return [];
    case "Pdf":
      return ["Nexus"];
    case "Epub":
      return ["Nexus", "ProjectGutenberg"];
    case "WebArticle":
      return ["Nexus", "Brave"];
    case "Video":
      return ["Nexus", "YouTube"];
    case "Podcast":
      return ["PodcastIndex"];
  }
}

export function decodeBrowseQuery(params: URLSearchParams): BrowseQueryDecode {
  for (const key of params.keys()) {
    if (!ALLOWED_KEYS.has(key)) return { kind: "Invalid" };
  }

  const rawText = hasExactlyOne(params, "q");
  const rawKind = hasExactlyOne(params, "kind");
  const rawSource = hasExactlyOne(params, "source");
  const rawSort = hasExactlyOne(params, "sort");
  if (
    rawText === undefined ||
    rawKind === undefined ||
    rawSource === undefined ||
    rawSort === undefined
  ) {
    return { kind: "Invalid" };
  }

  if (
    rawText !== null &&
    (rawText.length === 0 ||
      rawText !== rawText.trim() ||
      rawText !== rawText.normalize("NFC") ||
      countCodePoints(rawText) > 200 ||
      CONTROL_CHARACTER.test(rawText))
  ) {
    return { kind: "Invalid" };
  }

  const kind: BrowseQueryKind =
    rawKind === null
      ? "All"
      : BROWSE_KINDS.includes(rawKind as BrowseQueryKind) && rawKind !== "All"
        ? (rawKind as BrowseQueryKind)
        : "All";
  if (rawKind !== null && kind === "All") return { kind: "Invalid" };

  const source =
    rawSource === null
      ? null
      : BROWSE_SOURCES.includes(rawSource as BrowseQuerySource)
        ? (rawSource as BrowseQuerySource)
        : undefined;
  if (
    source === undefined ||
    (source !== null && !applicableSources(kind).includes(source))
  ) {
    return { kind: "Invalid" };
  }
  if (kind === "All" && source !== null) return { kind: "Invalid" };

  if (
    rawSort !== null &&
    (kind !== "Video" || source !== "YouTube" || rawSort !== "Newest")
  ) {
    return { kind: "Invalid" };
  }

  return {
    kind: "Valid",
    query: {
      text: rawText ?? "",
      kind,
      source,
      sort: rawSort === "Newest" ? "Newest" : "Relevance",
    },
  };
}

export function normalizeBrowseDraft(draft: string): string {
  return draft.trim().normalize("NFC");
}

export function isValidBrowseText(text: string): boolean {
  return (
    text.length > 0 &&
    text === text.trim() &&
    text === text.normalize("NFC") &&
    countCodePoints(text) <= 200 &&
    !CONTROL_CHARACTER.test(text)
  );
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

export function withBrowseKind(
  query: BrowseQuery,
  kind: BrowseQueryKind,
): BrowseQuery {
  return { ...query, kind, source: null, sort: "Relevance" };
}

export function withBrowseSource(
  query: BrowseQuery,
  source: BrowseQuerySource | null,
): BrowseQuery {
  return { ...query, source, sort: "Relevance" };
}

export type BrowsePreviewQueryDecode =
  | {
      readonly kind: "Valid";
      readonly target: DiscoveryTargetHandle;
    }
  | { readonly kind: "Invalid" };

export function decodeBrowsePreviewQuery(
  params: URLSearchParams,
): BrowsePreviewQueryDecode {
  const keys = [...params.keys()];
  if (
    keys.length !== 1 ||
    keys[0] !== "target" ||
    params.getAll("target").length !== 1
  ) {
    return { kind: "Invalid" };
  }
  try {
    // Kept at the route-query ingress so malformed links make no provider call.
    return {
      kind: "Valid",
      target: parseDiscoveryTargetHandle(params.get("target")),
    };
  } catch {
    return { kind: "Invalid" };
  }
}
