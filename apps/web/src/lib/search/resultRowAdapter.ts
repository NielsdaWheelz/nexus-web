import { apiFetch } from "@/lib/api/client";
import type { ContributorCredit } from "@/lib/contributors/types";

export const ALL_SEARCH_TYPES = [
  "contributor",
  "media",
  "podcast",
  "content_chunk",
  "page",
  "note_block",
  "message",
] as const;

export type SearchType = (typeof ALL_SEARCH_TYPES)[number];

interface SearchSourceMetadata {
  media_id: string;
  media_kind: string;
  title: string;
  contributors: ContributorCredit[];
  published_date: string | null;
}

interface SearchResolver {
  kind: "web" | "epub" | "pdf" | "transcript";
  route: string;
  params: Record<string, string>;
  status?: string;
  selector?: Record<string, unknown>;
  highlight?: unknown;
}

interface SearchBaseResult {
  id: string;
  score: number;
  snippet: string;
  title: string;
  source_label: string | null;
  media_id: string | null;
  media_kind: string | null;
  deep_link: string;
  context_ref: {
    type: SearchType;
    id: string;
    evidence_span_ids?: string[];
  };
}

interface SearchMediaResult extends SearchBaseResult {
  type: "media";
  source: SearchSourceMetadata;
}

interface SearchPodcastResult extends SearchBaseResult {
  type: "podcast";
  contributors: ContributorCredit[];
}

interface SearchContributorResult extends SearchBaseResult {
  type: "contributor";
  contributor_handle: string;
  contributor: {
    handle: string;
    display_name: string;
    status: string | null;
  };
}

interface SearchContentChunkResult extends SearchBaseResult {
  type: "content_chunk";
  media_id: string;
  media_kind: string;
  citation_label: string;
  source: SearchSourceMetadata;
  resolver: SearchResolver;
}

interface SearchNoteBlockResult extends SearchBaseResult {
  type: "note_block";
  page_id: string;
  page_title: string;
  body_text: string;
}

interface SearchPageResult extends SearchBaseResult {
  type: "page";
  description: string | null;
}

interface SearchMessageResult extends SearchBaseResult {
  type: "message";
  conversation_id: string;
  seq: number;
}

type SearchApiResult =
  | SearchMediaResult
  | SearchPodcastResult
  | SearchContributorResult
  | SearchContentChunkResult
  | SearchPageResult
  | SearchNoteBlockResult
  | SearchMessageResult;

interface SearchResponseShape {
  results: unknown[];
  page?: {
    next_cursor?: string | null;
  } | null;
}

export interface SearchResultRowViewModel {
  key: string;
  href: string;
  type: SearchType;
  mediaId: string | null;
  contextRef: {
    type: SearchType;
    id: string;
    evidenceSpanIds: string[];
  } | null;
  typeLabel: string;
  primaryText: string;
  snippetSegments: Array<{
    text: string;
    emphasized: boolean;
  }>;
  sourceMeta: string | null;
  contributorCredits: ContributorCredit[];
  noteBody: string | null;
  scoreLabel: string;
}

interface FetchSearchResultPageInput {
  query: string;
  selectedTypes: ReadonlySet<SearchType>;
  contributorHandles?: readonly string[];
  roles?: readonly string[];
  contentKinds?: readonly string[];
  limit: number;
  cursor?: string | null;
}

export interface SearchResultPage {
  rows: SearchResultRowViewModel[];
  nextCursor: string | null;
}

function isValidSource(value: unknown): value is SearchSourceMetadata {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const source = value as Record<string, unknown>;
  return (
    typeof source.media_id === "string" &&
    typeof source.media_kind === "string" &&
    typeof source.title === "string" &&
    Array.isArray(source.contributors)
  );
}

function resolveSource(
  result: Record<string, unknown>,
): SearchSourceMetadata | null {
  if (!isValidSource(result.source)) {
    return null;
  }
  return result.source;
}

function isValidResolver(value: unknown): value is SearchResolver {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const resolver = value as Record<string, unknown>;
  if (
    resolver.kind !== "web" &&
    resolver.kind !== "epub" &&
    resolver.kind !== "pdf" &&
    resolver.kind !== "transcript"
  ) {
    return false;
  }
  if (typeof resolver.route !== "string") {
    return false;
  }
  if (
    typeof resolver.params !== "object" ||
    resolver.params === null ||
    Array.isArray(resolver.params)
  ) {
    return false;
  }

  return Object.values(resolver.params).every(
    (value) => typeof value === "string",
  );
}

function stringField(
  record: Record<string, unknown>,
  ...keys: string[]
): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return "";
}

function nullableStringField(
  record: Record<string, unknown>,
  ...keys: string[]
): string | null {
  const value = stringField(record, ...keys);
  return value || null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeContributorCredit(value: unknown): ContributorCredit | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const credit = value as Record<string, unknown>;
  const sourceRef = credit.source_ref ?? credit.sourceRef;
  const contributorHandle = stringField(
    credit,
    "contributor_handle",
    "contributorHandle",
  );
  const contributorDisplayName = stringField(
    credit,
    "contributor_display_name",
    "contributorDisplayName",
  );
  const creditedName = stringField(credit, "credited_name", "creditedName");
  const role = stringField(credit, "role");
  const href = stringField(credit, "href");
  const source = stringField(credit, "source");
  let nestedDisplayName = "";
  if (typeof credit.contributor === "object" && credit.contributor !== null) {
    const contributor = credit.contributor as Record<string, unknown>;
    nestedDisplayName = stringField(contributor, "display_name", "displayName");
  }
  const displayName = contributorDisplayName || nestedDisplayName;
  if (
    !contributorHandle ||
    !displayName ||
    !creditedName ||
    !role ||
    !href ||
    !source
  ) {
    return null;
  }
  return {
    contributor_handle: contributorHandle,
    contributor_display_name: displayName,
    credited_name: creditedName,
    role,
    raw_role: nullableStringField(credit, "raw_role", "rawRole"),
    ordinal: typeof credit.ordinal === "number" ? credit.ordinal : null,
    source,
    source_ref: isPlainRecord(sourceRef) ? sourceRef : null,
    confidence:
      typeof credit.confidence === "string" ||
      typeof credit.confidence === "number"
        ? credit.confidence
        : null,
    href,
  };
}

function normalizeContributorCredits(
  value: unknown,
): ContributorCredit[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const credits: ContributorCredit[] = [];
  for (const item of value) {
    const credit = normalizeContributorCredit(item);
    if (!credit) {
      return null;
    }
    credits.push(credit);
  }
  return credits;
}

function normalizeSearchResult(result: unknown): SearchApiResult | null {
  if (typeof result !== "object" || result === null) {
    return null;
  }

  const row = result as Record<string, unknown>;
  if (typeof row.id !== "string") {
    return null;
  }
  if (typeof row.score !== "number") {
    return null;
  }
  if (typeof row.snippet !== "string") {
    return null;
  }
  if (typeof row.title !== "string") {
    return null;
  }
  if (typeof row.deep_link !== "string") {
    return null;
  }
  if (typeof row.context_ref !== "object" || row.context_ref === null) {
    return null;
  }
  const contextRef = row.context_ref as Record<string, unknown>;
  if (
    typeof contextRef.type !== "string" ||
    !ALL_SEARCH_TYPES.includes(contextRef.type as SearchType) ||
    typeof contextRef.id !== "string"
  ) {
    return null;
  }
  let evidenceSpanIds: string[] | undefined;
  if (contextRef.evidence_span_ids !== undefined) {
    if (
      !Array.isArray(contextRef.evidence_span_ids) ||
      !contextRef.evidence_span_ids.every((id) => typeof id === "string")
    ) {
      return null;
    }
    evidenceSpanIds = contextRef.evidence_span_ids;
  }

  const base = {
    id: row.id,
    score: row.score,
    snippet: row.snippet,
    title: row.title,
    source_label:
      typeof row.source_label === "string" ? row.source_label : null,
    media_id: typeof row.media_id === "string" ? row.media_id : null,
    media_kind: typeof row.media_kind === "string" ? row.media_kind : null,
    deep_link: row.deep_link,
    context_ref: {
      type: contextRef.type as SearchType,
      id: contextRef.id,
      ...(evidenceSpanIds ? { evidence_span_ids: evidenceSpanIds } : {}),
    },
  };

  switch (row.type) {
    case "media": {
      const source = resolveSource(row);
      if (!source) {
        return null;
      }
      const contributors = normalizeContributorCredits(source.contributors);
      if (!contributors) {
        return null;
      }
      return {
        ...base,
        type: "media",
        source: {
          ...source,
          contributors,
        },
      };
    }
    case "podcast": {
      const contributors = normalizeContributorCredits(row.contributors);
      if (!contributors) {
        return null;
      }
      return {
        ...base,
        type: "podcast",
        contributors,
      };
    }
    case "contributor": {
      const contributor = row.contributor as Record<string, unknown> | null;
      const contributorHandle = stringField(
        row,
        "contributor_handle",
        "contributorHandle",
      );
      if (
        !contributorHandle ||
        typeof contributor !== "object" ||
        contributor === null ||
        typeof contributor.handle !== "string" ||
        !stringField(contributor, "display_name", "displayName") ||
        base.context_ref.type !== "contributor"
      ) {
        return null;
      }
      return {
        ...base,
        type: "contributor",
        contributor_handle: contributorHandle,
        contributor: {
          handle: contributor.handle,
          display_name: stringField(contributor, "display_name", "displayName"),
          status: nullableStringField(contributor, "status"),
        },
      };
    }
    case "content_chunk": {
      if (
        typeof row.media_id !== "string" ||
        typeof row.media_kind !== "string" ||
        typeof row.citation_label !== "string" ||
        base.context_ref.type !== "content_chunk" ||
        !base.context_ref.evidence_span_ids ||
        base.context_ref.evidence_span_ids.length === 0 ||
        !isValidSource(row.source) ||
        !isValidResolver(row.resolver)
      ) {
        return null;
      }
      const contributors = normalizeContributorCredits(row.source.contributors);
      if (!contributors) {
        return null;
      }

      return {
        ...base,
        type: "content_chunk",
        media_id: row.media_id,
        media_kind: row.media_kind,
        citation_label: row.citation_label,
        source: {
          ...row.source,
          contributors,
        },
        resolver: row.resolver,
      };
    }
    case "page":
      return {
        ...base,
        type: "page",
        description:
          typeof row.description === "string" ? row.description : null,
      };
    case "note_block":
      if (
        typeof row.page_id !== "string" ||
        typeof row.page_title !== "string" ||
        typeof row.body_text !== "string"
      ) {
        return null;
      }
      return {
        ...base,
        type: "note_block",
        page_id: row.page_id,
        page_title: row.page_title,
        body_text: row.body_text,
      };
    case "message":
      if (
        typeof row.conversation_id !== "string" ||
        typeof row.seq !== "number"
      ) {
        return null;
      }

      return {
        ...base,
        type: "message",
        conversation_id: row.conversation_id,
        seq: row.seq,
      };
    default:
      return null;
  }
}

function buildSearchQueryParams({
  query,
  selectedTypes,
  contributorHandles = [],
  roles = [],
  contentKinds = [],
  limit,
  cursor = null,
}: FetchSearchResultPageInput): URLSearchParams {
  const params = new URLSearchParams({
    q: query.trim(),
    limit: String(limit),
  });

  const orderedSelectedTypes = ALL_SEARCH_TYPES.filter((type) =>
    selectedTypes.has(type),
  );
  if (orderedSelectedTypes.length === 0) {
    params.set("types", "");
  } else {
    params.set("types", orderedSelectedTypes.join(","));
  }
  if (cursor) {
    params.set("cursor", cursor);
  }
  const handles = contributorHandles
    .map((handle) => handle.trim())
    .filter(Boolean);
  if (handles.length > 0) {
    params.set("contributor_handles", handles.join(","));
  }
  const normalizedRoles = roles.map((role) => role.trim()).filter(Boolean);
  if (normalizedRoles.length > 0) {
    params.set("roles", normalizedRoles.join(","));
  }
  const normalizedContentKinds = contentKinds
    .map((contentKind) => contentKind.trim())
    .filter(Boolean);
  if (normalizedContentKinds.length > 0) {
    params.set("content_kinds", normalizedContentKinds.join(","));
  }

  return params;
}

function sanitizeSnippet(snippet: string): string {
  return snippet.replace(/<\/?b>/gi, "");
}

function parseSnippetSegments(snippet: string) {
  if (!snippet) {
    return [];
  }

  const segments: SearchResultRowViewModel["snippetSegments"] = [];
  const parts = snippet.split(/(<\/?b>)/gi);
  let emphasized = false;

  for (const part of parts) {
    const normalized = part.toLowerCase();
    if (normalized === "<b>") {
      emphasized = true;
      continue;
    }
    if (normalized === "</b>") {
      emphasized = false;
      continue;
    }
    if (!part) {
      continue;
    }
    segments.push({ text: part, emphasized });
  }

  return segments;
}

function buildSourceMeta(result: SearchApiResult): string | null {
  if (result.type === "contributor") {
    return result.contributor.status;
  }

  if (result.type === "message") {
    return result.source_label ?? `message #${result.seq}`;
  }

  if (result.type === "podcast") {
    return result.source_label;
  }

  if (result.type === "page") {
    return result.source_label;
  }

  if (result.type === "note_block") {
    return result.page_title;
  }

  if (result.source_label) {
    return result.source_label;
  }

  if (result.type === "content_chunk") {
    const parts = [result.title, result.media_kind.replace(/_/g, " ")];
    return parts.filter(Boolean).join(" — ") || null;
  }

  const parts = [result.source.title];
  if (result.source.published_date) {
    parts.push(result.source.published_date);
  }
  if (result.source.media_kind) {
    parts.push(result.source.media_kind.replace(/_/g, " "));
  }

  return parts.filter(Boolean).join(" — ") || null;
}

function buildResultHref(result: SearchApiResult): string {
  if (result.type === "content_chunk") {
    const params = new URLSearchParams();
    const evidence = result.resolver.params.evidence;
    if (evidence) {
      params.set("evidence", evidence);
    }
    for (const [key, value] of Object.entries(result.resolver.params)) {
      if (key !== "evidence") {
        params.set(key, value);
      }
    }
    const query = params.toString();
    return query ? `${result.resolver.route}?${query}` : result.resolver.route;
  }
  return result.deep_link;
}

function buildPrimaryText(result: SearchApiResult): string {
  if (result.type === "contributor") {
    return (
      result.contributor.display_name ||
      sanitizeSnippet(result.snippet) ||
      "Author"
    );
  }
  if (result.type === "note_block") {
    return result.body_text || sanitizeSnippet(result.snippet) || "Note";
  }
  if (result.type === "media" || result.type === "podcast") {
    return result.title || sanitizeSnippet(result.snippet) || "Untitled";
  }
  if (result.type === "page") {
    return result.title || sanitizeSnippet(result.snippet) || "Untitled page";
  }
  if (result.type === "message") {
    return sanitizeSnippet(result.snippet) || `Message #${result.seq}`;
  }
  return sanitizeSnippet(result.snippet);
}

function getContributorCredits(result: SearchApiResult): ContributorCredit[] {
  if (result.type === "media") {
    return result.source.contributors;
  }
  if (result.type === "podcast") {
    return result.contributors;
  }
  if (result.type === "content_chunk") {
    return result.source.contributors;
  }
  return [];
}

function adaptSearchResultRow(
  result: SearchApiResult,
): SearchResultRowViewModel {
  return {
    key: `${result.type}-${result.id}`,
    href: buildResultHref(result),
    type: result.type,
    mediaId: result.media_id,
    contextRef: {
      type: result.context_ref.type,
      id: result.context_ref.id,
      evidenceSpanIds: result.context_ref.evidence_span_ids ?? [],
    },
    typeLabel:
      result.type === "content_chunk"
        ? result.citation_label
        : result.type === "contributor"
          ? "author"
          : result.type === "page"
            ? "page"
            : result.type,
    primaryText: buildPrimaryText(result),
    snippetSegments: parseSnippetSegments(result.snippet),
    sourceMeta: buildSourceMeta(result),
    contributorCredits: getContributorCredits(result),
    noteBody: result.type === "note_block" ? result.body_text : null,
    scoreLabel: `score ${result.score.toFixed(2)}`,
  };
}

function adaptSearchResults(results: unknown[]): SearchResultRowViewModel[] {
  return results.flatMap((result) => {
    const normalized = normalizeSearchResult(result);
    if (!normalized) {
      console.warn("[search] dropping invalid result", result);
      return [];
    }
    return [adaptSearchResultRow(normalized)];
  });
}

export async function fetchSearchResultPage({
  query,
  selectedTypes,
  contributorHandles = [],
  roles = [],
  contentKinds = [],
  limit,
  cursor = null,
}: FetchSearchResultPageInput): Promise<SearchResultPage> {
  const response = await apiFetch<SearchResponseShape>(
    `/api/search?${buildSearchQueryParams({
      query,
      selectedTypes,
      contributorHandles,
      roles,
      contentKinds,
      limit,
      cursor,
    }).toString()}`,
  );

  return {
    rows: adaptSearchResults(
      Array.isArray(response.results) ? response.results : [],
    ),
    nextCursor:
      typeof response.page?.next_cursor === "string"
        ? response.page.next_cursor
        : null,
  };
}
