import { apiFetch, type ApiPath } from "@/lib/api/client";
import { requestWithRetry } from "@/lib/api/retryPolicy";
import type { ReaderNavigationSection } from "@/lib/media/readerNavigation";
import {
  createPaneFindSourceKey,
  type PaneFindSourceKey,
} from "@/lib/panes/paneSearch";
import {
  expectArray,
  expectBoolean,
  expectExactRecord,
  expectInteger,
  expectNonnegativeInteger,
  expectNullableString,
  expectOneOf,
  expectRecord,
  expectString,
} from "@/lib/validation";

export const EPUB_FIND_MATCH_LIMIT = 2000;

export interface EpubFindSnapshotFragment {
  readonly fragmentId: string;
  readonly fragmentIdx: number;
  readonly activationSectionId: string;
  readonly label: string;
  readonly charCount: number;
  readonly navigationLocationCount: number;
}

export interface EpubFindSnapshot {
  readonly mediaId: string;
  readonly sourceKey: PaneFindSourceKey;
  readonly sourceWitnessFragmentId: string;
  readonly fragments: readonly EpubFindSnapshotFragment[];
}

export type EpubFindScopeIn =
  | { readonly kind: "EntireResource" }
  | { readonly kind: "Section"; readonly section_id: string };

export interface EpubFindRequest {
  readonly source_witness_fragment_id: string;
  readonly query: string;
  readonly match_case: boolean;
  readonly whole_word: boolean;
  readonly scope: EpubFindScopeIn;
}

export interface EpubFindSnippetSegment {
  readonly text: string;
  readonly emphasized: boolean;
}

export interface EpubFindOccurrenceOut {
  readonly section_id: string;
  readonly section_label: string;
  readonly fragment_id: string;
  readonly fragment_idx: number;
  readonly start_offset: number;
  readonly end_offset: number;
  readonly snippet: readonly EpubFindSnippetSegment[];
}

export type EpubFindResultOut =
  | {
      readonly kind: "Ready";
      readonly source_witness_fragment_id: string;
      readonly occurrences: readonly EpubFindOccurrenceOut[];
    }
  | {
      readonly kind: "NoMatches";
      readonly source_witness_fragment_id: string;
    }
  | {
      readonly kind: "TooManyMatches";
      readonly source_witness_fragment_id: string;
      readonly threshold: typeof EPUB_FIND_MATCH_LIMIT;
    };

export interface EpubSectionContent {
  readonly section_id: string;
  readonly label: string;
  readonly fragment_id: string;
  readonly fragment_idx: number;
  readonly href_path: string | null;
  readonly anchor_id: string | null;
  readonly source_node_id: string | null;
  readonly source: "toc" | "spine";
  readonly ordinal: number;
  readonly prev_section_id: string | null;
  readonly next_section_id: string | null;
  readonly html_sanitized: string;
  readonly canonical_text: string;
  readonly char_count: number;
  readonly word_count: number;
  readonly document_word_start: number;
  readonly created_at: string;
}

type ApiFetch = (
  path: ApiPath,
  options?: RequestInit,
) => Promise<unknown>;

function snapshotDefect(message: string): never {
  throw new Error(`EPUB Find source defect: ${message}`);
}

export function createEpubFindSnapshot({
  mediaId,
  navigation,
}: {
  readonly mediaId: string;
  readonly navigation: readonly ReaderNavigationSection[];
}): EpubFindSnapshot {
  if (!mediaId) {
    snapshotDefect("media id is empty");
  }
  if (navigation.length === 0) {
    snapshotDefect("readable EPUB has no navigation");
  }

  const ordered = [...navigation].sort(
    (left, right) =>
      left.ordinal - right.ordinal ||
      left.section_id.localeCompare(right.section_id),
  );
  const sectionIds = new Set<string>();
  const ordinals = new Set<number>();
  const fragmentsById = new Map<string, EpubFindSnapshotFragment>();
  const fragmentIdsByIdx = new Map<number, string>();
  let previousFragmentId: string | null = null;

  for (const section of ordered) {
    if (
      !section.section_id ||
      sectionIds.has(section.section_id) ||
      ordinals.has(section.ordinal)
    ) {
      snapshotDefect("section ids and ordinals must be non-empty and unique");
    }
    sectionIds.add(section.section_id);
    ordinals.add(section.ordinal);
    if (
      !section.fragment_id ||
      section.fragment_idx === null ||
      section.fragment_idx < 0 ||
      section.char_count === null ||
      section.char_count < 0
    ) {
      snapshotDefect(
        `section ${section.section_id} lacks canonical fragment facts`,
      );
    }

    const indexedFragment = fragmentIdsByIdx.get(section.fragment_idx);
    if (indexedFragment && indexedFragment !== section.fragment_id) {
      snapshotDefect(`fragment index ${section.fragment_idx} is ambiguous`);
    }
    fragmentIdsByIdx.set(section.fragment_idx, section.fragment_id);

    const existing = fragmentsById.get(section.fragment_id);
    if (existing) {
      if (
        existing.fragmentIdx !== section.fragment_idx ||
        previousFragmentId !== section.fragment_id ||
        section.char_count !== 0
      ) {
        snapshotDefect(
          `navigation for fragment ${section.fragment_id} is contradictory`,
        );
      }
      fragmentsById.set(section.fragment_id, {
        ...existing,
        navigationLocationCount: existing.navigationLocationCount + 1,
      });
      previousFragmentId = section.fragment_id;
      continue;
    }

    fragmentsById.set(section.fragment_id, {
      fragmentId: section.fragment_id,
      fragmentIdx: section.fragment_idx,
      activationSectionId: section.section_id,
      label: section.label,
      charCount: section.char_count,
      navigationLocationCount: 1,
    });
    previousFragmentId = section.fragment_id;
  }

  const fragments = [...fragmentsById.values()]
    .sort(
      (left, right) =>
        left.fragmentIdx - right.fragmentIdx ||
        left.fragmentId.localeCompare(right.fragmentId),
    );
  if (fragments.length === 0) {
    snapshotDefect("readable EPUB has no canonical fragments");
  }
  for (let index = 1; index < fragments.length; index += 1) {
    if (fragments[index - 1]!.fragmentIdx >= fragments[index]!.fragmentIdx) {
      snapshotDefect("fragment order is not strictly increasing");
    }
  }

  return {
    mediaId,
    sourceKey: createPaneFindSourceKey({
      kind: "Epub",
      mediaId,
      fragments: fragments.map(
        ({
          fragmentId,
          fragmentIdx,
          activationSectionId,
          charCount,
          navigationLocationCount,
        }) => ({
          fragmentId,
          fragmentIdx,
          activationSectionId,
          charCount,
          navigationLocationCount,
        }),
      ),
    }),
    sourceWitnessFragmentId: fragments[0]!.fragmentId,
    fragments,
  };
}

function decodeSnippetSegment(
  raw: unknown,
  name: string,
): EpubFindSnippetSegment {
  const value = expectExactRecord(raw, ["text", "emphasized"], name);
  return {
    text: expectString(value.text, `${name}.text`),
    emphasized: expectBoolean(value.emphasized, `${name}.emphasized`),
  };
}

function decodeOccurrence(
  raw: unknown,
  name: string,
): EpubFindOccurrenceOut {
  const value = expectExactRecord(
    raw,
    [
      "section_id",
      "section_label",
      "fragment_id",
      "fragment_idx",
      "start_offset",
      "end_offset",
      "snippet",
    ],
    name,
  );
  const startOffset = expectNonnegativeInteger(
    value.start_offset,
    `${name}.start_offset`,
  );
  const endOffset = expectNonnegativeInteger(
    value.end_offset,
    `${name}.end_offset`,
  );
  if (endOffset <= startOffset) {
    throw new TypeError(`${name} must have a non-empty right-open range`);
  }
  const snippet = expectArray(
    value.snippet,
    (segment, index) =>
      decodeSnippetSegment(segment, `${name}.snippet[${index}]`),
    `${name}.snippet`,
  );
  if (
    snippet.length === 0 ||
    snippet.filter((segment) => segment.emphasized).length !== 1
  ) {
    throw new TypeError(
      `${name}.snippet must contain exactly one emphasized segment`,
    );
  }
  return {
    section_id: expectString(value.section_id, `${name}.section_id`),
    section_label: expectString(
      value.section_label,
      `${name}.section_label`,
    ),
    fragment_id: expectString(value.fragment_id, `${name}.fragment_id`),
    fragment_idx: expectNonnegativeInteger(
      value.fragment_idx,
      `${name}.fragment_idx`,
    ),
    start_offset: startOffset,
    end_offset: endOffset,
    snippet,
  };
}

export function decodeEpubFindResult(raw: unknown): EpubFindResultOut {
  const envelope = expectExactRecord(raw, ["data"], "EpubFindResponse");
  const candidate = expectRecord(
    envelope.data,
    "EpubFindResponse.data",
  );
  const kind = expectOneOf(
    candidate.kind,
    ["Ready", "NoMatches", "TooManyMatches"] as const,
    "EpubFindResponse.data.kind",
  );
  const data = expectExactRecord(
    candidate,
    kind === "Ready"
      ? ["kind", "source_witness_fragment_id", "occurrences"]
      : kind === "TooManyMatches"
        ? ["kind", "source_witness_fragment_id", "threshold"]
        : ["kind", "source_witness_fragment_id"],
    "EpubFindResponse.data",
  );
  const sourceWitnessFragmentId = expectString(
    data.source_witness_fragment_id,
    "EpubFindResponse.data.source_witness_fragment_id",
  );
  switch (kind) {
    case "Ready": {
      const occurrences = expectArray(
        data.occurrences,
        (occurrence, index) =>
          decodeOccurrence(
            occurrence,
            `EpubFindResponse.data.occurrences[${index}]`,
          ),
        "EpubFindResponse.data.occurrences",
      );
      if (
        occurrences.length === 0 ||
        occurrences.length > EPUB_FIND_MATCH_LIMIT
      ) {
        throw new TypeError(
          "EpubFindResponse Ready must contain 1..2000 occurrences",
        );
      }
      return {
        kind,
        source_witness_fragment_id: sourceWitnessFragmentId,
        occurrences,
      };
    }
    case "NoMatches":
      return {
        kind,
        source_witness_fragment_id: sourceWitnessFragmentId,
      };
    case "TooManyMatches": {
      const threshold = expectInteger(
        data.threshold,
        "EpubFindResponse.data.threshold",
      );
      if (threshold !== EPUB_FIND_MATCH_LIMIT) {
        throw new TypeError("EpubFindResponse threshold must be 2000");
      }
      return {
        kind,
        source_witness_fragment_id: sourceWitnessFragmentId,
        threshold,
      };
    }
  }
}

export function decodeEpubSectionContent(raw: unknown): EpubSectionContent {
  const envelope = expectExactRecord(raw, ["data"], "EpubSectionResponse");
  const value = expectExactRecord(
    envelope.data,
    [
      "section_id",
      "label",
      "fragment_id",
      "fragment_idx",
      "href_path",
      "anchor_id",
      "source_node_id",
      "source",
      "ordinal",
      "prev_section_id",
      "next_section_id",
      "html_sanitized",
      "canonical_text",
      "char_count",
      "word_count",
      "document_word_start",
      "created_at",
    ],
    "EpubSectionResponse.data",
  );
  return {
    section_id: expectString(
      value.section_id,
      "EpubSectionResponse.data.section_id",
    ),
    label: expectString(value.label, "EpubSectionResponse.data.label"),
    fragment_id: expectString(
      value.fragment_id,
      "EpubSectionResponse.data.fragment_id",
    ),
    fragment_idx: expectNonnegativeInteger(
      value.fragment_idx,
      "EpubSectionResponse.data.fragment_idx",
    ),
    href_path: expectNullableString(
      value.href_path,
      "EpubSectionResponse.data.href_path",
    ),
    anchor_id: expectNullableString(
      value.anchor_id,
      "EpubSectionResponse.data.anchor_id",
    ),
    source_node_id: expectNullableString(
      value.source_node_id,
      "EpubSectionResponse.data.source_node_id",
    ),
    source: expectOneOf(
      value.source,
      ["toc", "spine"] as const,
      "EpubSectionResponse.data.source",
    ),
    ordinal: expectNonnegativeInteger(
      value.ordinal,
      "EpubSectionResponse.data.ordinal",
    ),
    prev_section_id: expectNullableString(
      value.prev_section_id,
      "EpubSectionResponse.data.prev_section_id",
    ),
    next_section_id: expectNullableString(
      value.next_section_id,
      "EpubSectionResponse.data.next_section_id",
    ),
    html_sanitized: expectString(
      value.html_sanitized,
      "EpubSectionResponse.data.html_sanitized",
    ),
    canonical_text: expectString(
      value.canonical_text,
      "EpubSectionResponse.data.canonical_text",
    ),
    char_count: expectNonnegativeInteger(
      value.char_count,
      "EpubSectionResponse.data.char_count",
    ),
    word_count: expectNonnegativeInteger(
      value.word_count,
      "EpubSectionResponse.data.word_count",
    ),
    document_word_start: expectNonnegativeInteger(
      value.document_word_start,
      "EpubSectionResponse.data.document_word_start",
    ),
    created_at: expectString(
      value.created_at,
      "EpubSectionResponse.data.created_at",
    ),
  };
}

export async function requestEpubFind({
  mediaId,
  request,
  signal,
  fetchFn = apiFetch,
}: {
  readonly mediaId: string;
  readonly request: EpubFindRequest;
  readonly signal: AbortSignal;
  readonly fetchFn?: ApiFetch;
}): Promise<EpubFindResultOut> {
  const path = `/api/media/${mediaId}/epub-find` as ApiPath;
  const raw = await requestWithRetry(
    (attemptSignal) =>
      fetchFn(path, {
        method: "POST",
        body: JSON.stringify(request),
        signal: attemptSignal,
      }),
    signal,
  );
  return decodeEpubFindResult(raw);
}

export async function requestEpubSection({
  mediaId,
  sectionId,
  signal,
  fetchFn = apiFetch,
}: {
  readonly mediaId: string;
  readonly sectionId: string;
  readonly signal: AbortSignal;
  readonly fetchFn?: ApiFetch;
}): Promise<EpubSectionContent> {
  const path =
    `/api/media/${mediaId}/sections/${encodeURIComponent(sectionId)}` as ApiPath;
  const raw = await requestWithRetry(
    (attemptSignal) => fetchFn(path, { signal: attemptSignal }),
    signal,
  );
  return decodeEpubSectionContent(raw);
}
