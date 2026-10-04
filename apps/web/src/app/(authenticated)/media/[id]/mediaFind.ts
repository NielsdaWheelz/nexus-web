import { apiFetch, isApiError } from "@/lib/api/client";
import { absent } from "@/lib/api/presence";
import type { ApiJson } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  findInUnits,
  highlightPainter,
  type FindSource,
  type FindUnit,
  type TextHit,
} from "@/lib/find/find";
import type { CanonicalCursorResult } from "@/lib/highlights/canonicalCursor";
import { resolveDomTextRanges } from "@/lib/highlights/domTextRanges";
import type { MediaNavigation } from "@/lib/media/readerNavigation";
import { resolveTranscriptChapterInterval } from "@/lib/media/transcriptChapters";
import {
  formatTranscriptTimestampMs,
  type Fragment,
  type TranscriptChapter,
} from "@/lib/media/transcriptView";
import { findFirstVisibleCanonicalOffset } from "@/lib/reader/canonicalTextAnchor";
import {
  readerSectionAtPosition,
  type ReaderDocumentStructure,
  type ReaderPositionedSection,
} from "@/lib/reader/readerDocumentPosition";
import type { ReaderNavigationOutcome } from "@/lib/reader/useReaderNavigation";

type InspectText = (
  hit: TextHit,
  signal: AbortSignal,
) => Promise<ReaderNavigationOutcome>;
type Anchor = { readonly unit: string; readonly offset: number } | null;
const UNAVAILABLE = "Find request unavailable. Retry.";

/** The fragment on screen, published by the reader once its canonical cursor is valid and laid out. */
export interface RenderedFragment {
  readonly fragmentId: string;
  readonly cursor: CanonicalCursorResult;
  readonly viewport: HTMLElement;
}

/** The reader owns movement and the way back (its held spot); find only words its refusals. */
async function revealText(
  outcome: Promise<ReaderNavigationOutcome>,
): Promise<string | null> {
  const settled = await outcome;
  if (settled.kind !== "Unavailable") return null;
  return settled.reason === "CaptureUnavailable"
    ? "Reading position is unavailable."
    : UNAVAILABLE;
}

/**
 * EPUB: the reader holds one section, so find loads the book's canonical text
 * once per navigation generation. Null is a retryable failure; fragments that
 * disagree with the navigation mean the book changed under it.
 */
export function epubUnits(
  mediaId: string,
  navigation: MediaNavigation,
  onSourceChanged: () => void,
) {
  let loading: Promise<readonly FindUnit[] | null> | null = null;
  const expected = navigation.fragments
    .map((fragment) => fragment.fragment_id)
    .join();
  return () =>
    (loading ??= apiFetch<ApiJson<"/media/{media_id}/fragments", "get">>(
      `/api/media/${mediaId}/fragments`,
    ).then(
      ({ data }) => {
        if (data.map((fragment) => fragment.id).join() === expected)
          return data.map(({ id, canonical_text }) => ({
            id,
            text: canonical_text,
          }));
        loading = null;
        onSourceChanged();
        return null;
      },
      (error: unknown) => {
        loading = null;
        if (handleUnauthenticatedApiError(error))
          throw new DOMException("Sign-in took over.", "AbortError");
        if (isApiError(error)) return null;
        throw error;
      },
    ));
}

/** Web article and EPUB: one unit per fragment; scope, context and anchor come from the reader's section structure. */
export function textFindSource(input: {
  readonly key: string;
  readonly label: string;
  readonly structure: ReaderDocumentStructure;
  readonly units: () => Promise<readonly FindUnit[] | null>;
  readonly rendered: () => RenderedFragment | null;
  readonly inspect: InspectText;
}): FindSource<TextHit> {
  const { structure, rendered } = input;
  let anchor: Anchor = null;
  let extent: { readonly start: number; readonly end: number } | null = null;
  const section = (unit: string, offset: number) => {
    const fragment = structure.fragmentOffsets.get(unit);
    return fragment
      ? readerSectionAtPosition(structure, fragment.start + offset)
      : absent<ReaderPositionedSection>();
  };
  const slice = (
    unit: FindUnit,
    { start, end }: NonNullable<typeof extent>,
  ): FindUnit[] => {
    const fragment = structure.fragmentOffsets.get(unit.id);
    if (!fragment) return [];
    const from = Math.max(0, start - fragment.start);
    const to = Math.min(fragment.length, end - fragment.start);
    return to > from
      ? [
          {
            id: unit.id,
            text: Array.from(unit.text).slice(from, to).join(""),
            base: from,
          },
        ]
      : [];
  };
  return {
    key: input.key,
    label: input.label,
    prepare() {
      void input.units().catch(() => undefined); // prefetch; search reports the failure
      const view = rendered();
      const offset =
        view && findFirstVisibleCanonicalOffset(view.viewport, view.cursor);
      anchor =
        view && offset !== null ? { unit: view.fragmentId, offset } : null;
      const current = anchor
        ? section(anchor.unit, anchor.offset)
        : absent<ReaderPositionedSection>();
      extent =
        current.kind === "Present" && current.value.extent.kind === "Present"
          ? current.value.extent.value
          : null;
      return extent && "This section";
    },
    async search(options, narrow) {
      const units = await input.units();
      if (units === null) return { kind: "Failed", message: UNAVAILABLE };
      const scoped =
        narrow && extent
          ? units.flatMap((unit) => slice(unit, extent!))
          : units;
      return findInUnits(
        scoped,
        options,
        (hit) => {
          const current = section(hit.unit, hit.start);
          return {
            at: hit,
            context:
              current.kind === "Present" ? [current.value.section.label] : [],
          };
        },
        anchor,
      );
    },
    reveal: (hit, signal) => revealText(input.inspect(hit, signal)),
    // Only the rendered fragment has DOM; a match elsewhere paints once a reveal renders it.
    paint: highlightPainter((hit) => {
      const view = rendered();
      return view?.fragmentId === hit.unit
        ? (resolveDomTextRanges(view.cursor, hit.start, hit.end) ?? [])
        : [];
    }),
  };
}

/** Podcast and video: one unit per transcript segment; every segment is in the DOM as one text node. */
export function transcriptFindSource(input: {
  readonly key: string;
  readonly fragments: readonly Fragment[];
  readonly chapters: readonly TranscriptChapter[];
  readonly partial: boolean;
  readonly activeId: () => string | null;
  readonly list: () => HTMLElement | null;
  readonly inspect: InspectText;
}): FindSource<TextHit> {
  const byId = new Map(
    input.fragments.map((fragment) => [fragment.id, fragment]),
  );
  const chapter = (fragment: Fragment | undefined) =>
    fragment
      ? resolveTranscriptChapterInterval({
          chapters: input.chapters,
          timestampMs: fragment.t_start_ms,
        })
      : null;
  let anchor: Anchor = null;
  let narrowTo: number | null = null;
  return {
    key: input.key,
    label: "Find in transcript",
    prepare() {
      const active = byId.get(input.activeId() ?? "");
      anchor = active ? { unit: active.id, offset: 0 } : null;
      narrowTo = chapter(active)?.ordinal ?? null;
      return narrowTo === null ? null : "This chapter";
    },
    search(options, narrow) {
      const units = input.fragments
        .filter(
          (fragment) => !narrow || chapter(fragment)?.ordinal === narrowTo,
        )
        .map((fragment) => ({
          id: fragment.id,
          text: fragment.canonical_text,
        }));
      return findInUnits(
        units,
        options,
        (hit) => {
          const fragment = byId.get(hit.unit)!;
          const context = [
            chapter(fragment)?.chapter.title,
            formatTranscriptTimestampMs(fragment.t_start_ms),
            fragment.speaker_label,
          ];
          return {
            at: hit,
            context: context.filter((part): part is string => Boolean(part)),
          };
        },
        anchor,
        input.partial ? "available transcript" : null,
      );
    },
    reveal: (hit, signal) => revealText(input.inspect(hit, signal)),
    // TranscriptContentPanel renders canonical_text verbatim as one text node, so codepoint offsets map directly.
    paint: highlightPainter((hit) => {
      const node = input
        .list()
        ?.querySelector(
          `[data-transcript-fragment-id="${CSS.escape(hit.unit)}"] [data-transcript-fragment-text]`,
        )?.firstChild;
      if (!(node instanceof Text)) return [];
      const utf16 = (codepoint: number) =>
        Array.from(node.data).slice(0, codepoint).join("").length;
      const range = document.createRange();
      range.setStart(node, utf16(hit.start));
      range.setEnd(node, utf16(hit.end));
      return [range];
    }),
  };
}
