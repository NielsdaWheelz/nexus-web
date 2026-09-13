import { decodePresence, type Presence } from "@/lib/api/presence";
import { apiFetch, type ApiPath } from "@/lib/api/client";
import { requestWithRetry } from "@/lib/api/retryPolicy";
import type { MediaNavigation } from "@/lib/media/readerNavigation";
import { buildReaderDocumentStructure, type ReaderDocumentStructure } from "@/lib/reader/readerDocumentPosition";
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
  expectOneOf,
  expectRecord,
  expectString,
} from "@/lib/validation";

export const EPUB_FIND_MATCH_LIMIT = 2000;

export interface EpubFindSnapshotFragment {
  readonly fragmentId: string;
  readonly fragmentIdx: number;
  readonly charCount: number;
}

export interface EpubFindSnapshot {
  readonly mediaId: string;
  readonly sourceKey: PaneFindSourceKey;
  readonly generation: number;
  readonly structure: ReaderDocumentStructure;
  readonly sourceWitnessFragmentId: string;
  readonly fragments: readonly EpubFindSnapshotFragment[];
}

export type EpubFindScopeIn =
  | { readonly kind: "EntireResource" }
  | { readonly kind: "Section"; readonly section_id: string };

export interface EpubFindRequest {
  readonly source_witness_fragment_id: string;
  readonly source_generation: number;
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
  readonly section: Presence<{ section_id: string; label: string }>;
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
  readonly source_generation: number;
      readonly occurrences: readonly EpubFindOccurrenceOut[];
    }
  | {
      readonly kind: "NoMatches";
      readonly source_witness_fragment_id: string;
  readonly source_generation: number;
    }
  | {
      readonly kind: "TooManyMatches";
      readonly source_witness_fragment_id: string;
  readonly source_generation: number;
      readonly threshold: typeof EPUB_FIND_MATCH_LIMIT;
    };


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
  readonly navigation: MediaNavigation;
}): EpubFindSnapshot {
  const { fragments, generation } = navigation;
  if (fragments.length === 0) {
    // justify-defect: readable epub publication owns at least one fragment.
    snapshotDefect("readable EPUB has no canonical fragments");
  }
  const snapshotFragments = fragments.map((fragment) => {
    return {
      fragmentId: fragment.fragment_id,
      fragmentIdx: fragment.fragment_idx,
      charCount: fragment.char_count,
    };
  });
  return {
    mediaId,
    generation,
    structure: buildReaderDocumentStructure(navigation),
    sourceKey: createPaneFindSourceKey({ kind: "Epub", mediaId, generation, fragments: snapshotFragments }),
    sourceWitnessFragmentId: fragments[0]!.fragment_id,
    fragments: snapshotFragments,
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
      "section",
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
    section: decodePresence(value.section, (rawSection) => {
      const section = expectExactRecord(rawSection, ["section_id", "label"], `${name}.section.value`);
      return {
        section_id: expectString(section.section_id, `${name}.section.value.section_id`),
        label: expectString(section.label, `${name}.section.value.label`),
      };
    }),
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
      ? ["kind", "source_generation", "source_witness_fragment_id", "occurrences"]
      : kind === "TooManyMatches"
        ? ["kind", "source_generation", "source_witness_fragment_id", "threshold"]
        : ["kind", "source_generation", "source_witness_fragment_id"],
    "EpubFindResponse.data",
  );
  const sourceWitnessFragmentId = expectString(
    data.source_witness_fragment_id,
    "EpubFindResponse.data.source_witness_fragment_id",
  );
  const sourceGeneration = expectInteger(data.source_generation, "EpubFindResponse.data.source_generation");
  if (sourceGeneration < 1) throw new TypeError("EPUB Find source generation must be positive");
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
        source_generation: sourceGeneration,
        occurrences,
      };
    }
    case "NoMatches":
      return {
        kind,
        source_witness_fragment_id: sourceWitnessFragmentId,
        source_generation: sourceGeneration,
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
        source_generation: sourceGeneration,
        threshold,
      };
    }
  }
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
