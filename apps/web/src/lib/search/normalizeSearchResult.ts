import {
  isMediaRetrievalLocator,
  isRetrievalLocator,
  type RetrievalLocator,
} from "@/lib/api/sse/locators";
import type { ContributorCredit } from "@/lib/contributors/types";
import { hasLegacyArtifactIdentityKey } from "@/lib/currentArtifactIdentity";
import { normalizeResourceActivation } from "@/lib/resources/activation";
import { isRecord } from "@/lib/validation";
import {
  RESULT_TYPE_VALUES,
  type SearchApiResult,
  type SearchSourceMetadata,
  type SearchType,
} from "./types";

function isValidSource(value: unknown): value is SearchSourceMetadata {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const source = value as Record<string, unknown>;
  return (
    hasOnlyKeys(source, [
      "media_id",
      "media_kind",
      "title",
      "contributors",
      "published_date",
      "summary_md",
    ]) &&
    typeof source.media_id === "string" &&
    typeof source.media_kind === "string" &&
    typeof source.title === "string" &&
    Array.isArray(source.contributors) &&
    (source.published_date === undefined ||
      source.published_date === null ||
      typeof source.published_date === "string") &&
    (source.summary_md === undefined ||
      source.summary_md === null ||
      typeof source.summary_md === "string")
  );
}

function hasOnlyKeys(record: Record<string, unknown>, allowedKeys: readonly string[]) {
  return Object.keys(record).every((key) => allowedKeys.includes(key));
}

function hasOnlySearchResultKeys(row: Record<string, unknown>) {
  const baseKeys = [
    "type",
    "id",
    "score",
    "snippet",
    "title",
    "source_label",
    "media_id",
    "media_kind",
    "resource_ref",
    "activation",
    "citation_target",
    "context_ref",
  ];
  switch (row.type) {
    case "media":
    case "episode":
    case "video":
      return hasOnlyKeys(row, [...baseKeys, "source"]);
    case "podcast":
      return hasOnlyKeys(row, [...baseKeys, "contributors"]);
    case "contributor":
      return hasOnlyKeys(row, [...baseKeys, "contributor_handle", "contributor"]);
    case "content_chunk":
      return hasOnlyKeys(row, [
        ...baseKeys,
        "source_kind",
        "evidence_span_ids",
        "source",
        "citation_label",
        "locator",
      ]);
    case "fragment":
      return hasOnlyKeys(row, [...baseKeys, "source", "citation_label", "locator"]);
    case "page":
    case "conversation":
      return hasOnlyKeys(row, baseKeys);
    case "note_block":
      return hasOnlyKeys(row, [
        ...baseKeys,
        "body_text",
        "highlight_excerpt",
        "locator",
      ]);
    case "highlight":
      return hasOnlyKeys(row, [
        ...baseKeys,
        "color",
        "exact",
        "source",
        "citation_label",
        "locator",
      ]);
    case "message":
      return hasOnlyKeys(row, [...baseKeys, "conversation_id", "seq", "locator"]);
    case "evidence_span":
      return hasOnlyKeys(row, [
        ...baseKeys,
        "source",
        "evidence_span_id",
        "citation_label",
        "locator",
      ]);
    case "reader_apparatus_item":
      return hasOnlyKeys(row, [
        ...baseKeys,
        "source",
        "apparatus_kind",
        "locator",
      ]);
    case "web_result":
      return hasOnlyKeys(row, [
        ...baseKeys,
        "result_type",
        "source_id",
        "result_ref",
        "url",
        "display_url",
        "extra_snippets",
        "published_at",
        "source_name",
        "rank",
        "provider",
        "provider_request_id",
        "locator",
        "selected",
      ]);
    default:
      return false;
  }
}

function resolveSource(
  result: Record<string, unknown>,
): SearchSourceMetadata | null {
  if (!isValidSource(result.source)) {
    return null;
  }
  return result.source;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function nullableStringField(
  record: Record<string, unknown>,
  key: string,
): string | null {
  return stringField(record, key) || null;
}

function locatorMatchesSearchType(
  type: SearchType,
  locator: RetrievalLocator,
): boolean {
  if (type === "evidence_span") {
    return (
      isMediaRetrievalLocator(locator) || locator.type === "note_block_offsets"
    );
  }
  if (
    type === "content_chunk" ||
    type === "fragment" ||
    type === "highlight" ||
    type === "reader_apparatus_item"
  )
    return isMediaRetrievalLocator(locator);
  if (type === "note_block") return locator.type === "note_block_offsets";
  if (type === "message") return locator.type === "message_offsets";
  if (type === "web_result") return locator.type === "external_url";
  return false;
}

function normalizeContributorCredit(value: unknown): ContributorCredit | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const credit = value as Record<string, unknown>;
  const contributorHandle = stringField(credit, "contributor_handle");
  const contributorDisplayName = stringField(credit, "contributor_display_name");
  const creditedName = stringField(credit, "credited_name");
  const role = stringField(credit, "role");
  const href = stringField(credit, "href");
  const source = stringField(credit, "source");
  let nestedDisplayName = "";
  if (typeof credit.contributor === "object" && credit.contributor !== null) {
    const contributor = credit.contributor as Record<string, unknown>;
    nestedDisplayName = stringField(contributor, "display_name");
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
    raw_role: nullableStringField(credit, "raw_role"),
    ordinal: typeof credit.ordinal === "number" ? credit.ordinal : null,
    source,
    source_ref: isRecord(credit.source_ref) ? credit.source_ref : null,
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

export function normalizeSearchResult(result: unknown): SearchApiResult | null {
  if (typeof result !== "object" || result === null) {
    return null;
  }

  const row = result as Record<string, unknown>;
  if (!hasOnlySearchResultKeys(row)) {
    return null;
  }
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
  if (typeof row.resource_ref !== "string") {
    return null;
  }
  const activation = normalizeResourceActivation(row.activation);
  if (!activation || activation.kind === "none" || !activation.href) {
    return null;
  }
  if (row.citation_target !== null && typeof row.citation_target !== "string") {
    return null;
  }
  if (typeof row.context_ref !== "object" || row.context_ref === null) {
    return null;
  }
  const contextRef = row.context_ref as Record<string, unknown>;
  if (!hasOnlyKeys(contextRef, ["type", "id", "evidence_span_ids", "locator"])) {
    return null;
  }
  if (hasLegacyArtifactIdentityKey(row)) {
    return null;
  }
  if (
    typeof contextRef.type !== "string" ||
    !RESULT_TYPE_VALUES.includes(contextRef.type as SearchType) ||
    typeof contextRef.id !== "string"
  ) {
    return null;
  }
  let evidenceSpanIds: string[] | undefined;
  let contextRefLocator: RetrievalLocator | null | undefined;
  if (contextRef.evidence_span_ids !== undefined) {
    if (
      !Array.isArray(contextRef.evidence_span_ids) ||
      !contextRef.evidence_span_ids.every((id) => typeof id === "string")
    ) {
      return null;
    }
    evidenceSpanIds = contextRef.evidence_span_ids;
  }
  if (contextRef.locator !== undefined && contextRef.locator !== null) {
    if (
      !isRetrievalLocator(contextRef.locator) ||
      !locatorMatchesSearchType(contextRef.type as SearchType, contextRef.locator)
    ) {
      return null;
    }
    contextRefLocator = contextRef.locator;
  } else if (contextRef.locator === null) {
    contextRefLocator = null;
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
    resource_ref: row.resource_ref,
    activation,
    citation_target: row.citation_target,
    context_ref: {
      type: contextRef.type as SearchType,
      id: contextRef.id,
      ...(evidenceSpanIds ? { evidence_span_ids: evidenceSpanIds } : {}),
      ...(contextRefLocator !== undefined ? { locator: contextRefLocator } : {}),
    },
  };

  switch (row.type) {
    case "media": {
      if (base.context_ref.type !== row.type) {
        return null;
      }
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
    case "episode":
    case "video": {
      if (base.context_ref.type !== "media") {
        return null;
      }
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
        type: row.type,
        source: {
          ...source,
          contributors,
        },
      };
    }
    case "podcast": {
      const contributors = normalizeContributorCredits(row.contributors);
      if (!contributors || base.context_ref.type !== "podcast") {
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
      const contributorHandle = stringField(row, "contributor_handle");
      if (
        !contributorHandle ||
        typeof contributor !== "object" ||
        contributor === null ||
        typeof contributor.handle !== "string" ||
        !stringField(contributor, "display_name") ||
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
          display_name: stringField(contributor, "display_name"),
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
        !isRetrievalLocator(row.locator) ||
        !locatorMatchesSearchType("content_chunk", row.locator)
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
        locator: row.locator,
      };
    }
    case "fragment": {
      if (
        !isRetrievalLocator(row.locator) ||
        !locatorMatchesSearchType("fragment", row.locator) ||
        !isValidSource(row.source) ||
        base.context_ref.type !== "fragment"
      ) {
        return null;
      }
      const contributors = normalizeContributorCredits(row.source.contributors);
      if (!contributors) {
        return null;
      }
      return {
        ...base,
        type: "fragment",
        citation_label:
          typeof row.citation_label === "string" ? row.citation_label : null,
        locator: row.locator,
        source: {
          ...row.source,
          contributors,
        },
      };
    }
    case "page":
      if (base.context_ref.type !== "page") {
        return null;
      }
      return {
        ...base,
        type: "page",
      };
    case "note_block":
      if (
        typeof row.body_text !== "string" ||
        !isRetrievalLocator(row.locator) ||
        !locatorMatchesSearchType("note_block", row.locator) ||
        base.context_ref.type !== "note_block"
      ) {
        return null;
      }
      return {
        ...base,
        type: "note_block",
        body_text: row.body_text,
        highlight_excerpt:
          typeof row.highlight_excerpt === "string" ? row.highlight_excerpt : null,
        locator: row.locator,
      };
    case "highlight": {
      if (
        typeof row.color !== "string" ||
        typeof row.exact !== "string" ||
        !isRetrievalLocator(row.locator) ||
        !locatorMatchesSearchType("highlight", row.locator) ||
        !isValidSource(row.source) ||
        base.context_ref.type !== "highlight"
      ) {
        return null;
      }
      const contributors = normalizeContributorCredits(row.source.contributors);
      if (!contributors) {
        return null;
      }
      return {
        ...base,
        type: "highlight",
        color: row.color,
        exact: row.exact,
        citation_label:
          typeof row.citation_label === "string" ? row.citation_label : null,
        locator: row.locator,
        source: {
          ...row.source,
          contributors,
        },
      };
    }
    case "message":
      if (
        typeof row.conversation_id !== "string" ||
        typeof row.seq !== "number" ||
        !isRetrievalLocator(row.locator) ||
        !locatorMatchesSearchType("message", row.locator) ||
        base.context_ref.type !== "message"
      ) {
        return null;
      }

      return {
        ...base,
        type: "message",
        conversation_id: row.conversation_id,
        seq: row.seq,
        locator: row.locator,
      };
    case "evidence_span": {
      if (
        typeof row.evidence_span_id !== "string" ||
        typeof row.citation_label !== "string" ||
        !isRetrievalLocator(row.locator) ||
        !locatorMatchesSearchType("evidence_span", row.locator) ||
        !isValidSource(row.source) ||
        base.context_ref.type !== "evidence_span"
      ) {
        return null;
      }
      const contributors = normalizeContributorCredits(row.source.contributors);
      if (!contributors) {
        return null;
      }
      return {
        ...base,
        type: "evidence_span",
        evidence_span_id: row.evidence_span_id,
        citation_label: row.citation_label,
        locator: row.locator,
        source: {
          ...row.source,
          contributors,
        },
      };
    }
    case "reader_apparatus_item": {
      if (
        typeof row.apparatus_kind !== "string" ||
        !isRetrievalLocator(row.locator) ||
        !locatorMatchesSearchType("reader_apparatus_item", row.locator) ||
        !isValidSource(row.source) ||
        base.context_ref.type !== "reader_apparatus_item"
      ) {
        return null;
      }
      const contributors = normalizeContributorCredits(row.source.contributors);
      if (!contributors) {
        return null;
      }
      return {
        ...base,
        type: "reader_apparatus_item",
        apparatus_kind: row.apparatus_kind,
        locator: row.locator,
        source: {
          ...row.source,
          contributors,
        },
      };
    }
    case "conversation":
      if (base.context_ref.type !== "conversation") {
        return null;
      }
      return {
        ...base,
        type: "conversation",
      };
    case "web_result":
      if (
        base.context_ref.type !== "web_result" ||
        row.result_type !== "web_result" ||
        typeof row.source_id !== "string" ||
        base.context_ref.id !== row.source_id ||
        typeof row.result_ref !== "string" ||
        typeof row.url !== "string" ||
        !isRetrievalLocator(row.locator) ||
        row.locator.type !== "external_url" ||
        !Array.isArray(row.extra_snippets) ||
        !row.extra_snippets.every((snippet) => typeof snippet === "string") ||
        typeof row.selected !== "boolean"
      ) {
        return null;
      }
      return {
        ...base,
        type: "web_result",
        result_type: "web_result",
        source_id: row.source_id,
        result_ref: row.result_ref,
        url: row.url,
        display_url:
          typeof row.display_url === "string" ? row.display_url : null,
        extra_snippets: row.extra_snippets,
        published_at:
          typeof row.published_at === "string" ? row.published_at : null,
        source_name:
          typeof row.source_name === "string" ? row.source_name : null,
        rank: typeof row.rank === "number" ? row.rank : null,
        provider: typeof row.provider === "string" ? row.provider : null,
        locator: row.locator,
        selected: row.selected,
      };
    default:
      return null;
  }
}
