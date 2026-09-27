"use client";

import {
  useLayoutEffect,
  useMemo,
  useRef,
  type RefObject,
} from "react";
import {
  validateCanonicalText,
  type CanonicalCursorResult,
} from "@/lib/highlights/canonicalCursor";
import type { Fragment } from "@/lib/media/transcriptView";
import type { ReaderNavigationSection } from "@/lib/media/readerNavigation";
import { buildReaderDocumentStructure, readerSectionAtPosition, readerTextPointOffset, type ReaderDocumentStructure } from "@/lib/reader/readerDocumentPosition";
import { canonicalCpLength } from "@/lib/reader/textOffsets";
import {
  createPaneFindResultKey,
  createPaneFindSourceKey,
  type PaneFindResultKey,
  type PaneFindSourceKey,
} from "@/lib/panes/paneSearch";
import { type PaneFindPreviewReceipt } from "@/lib/panes/usePaneFind";
import { canonicalTextFind } from "@/lib/reader/canonicalTextFind";
import {
  createCanonicalTextFindPresentationOwner,
  type CanonicalTextFindAdapter,
  type CanonicalTextFindPresentationOwner,
  type ReaderTextFindNavigation,
} from "@/lib/reader/canonicalTextFindPresentation";
import {
  findFirstVisibleCanonicalOffset,
} from "@/lib/reader/canonicalTextAnchor";
import {
  mediaPaneFindErrorMessage,
  type MediaPaneFindError,
} from "./mediaPaneFind";

const ENTIRE_ARTICLE_SCOPE_ID = "EntireArticle";
const CURRENT_SECTION_SCOPE_PREFIX = "CurrentSection:";
interface WebFindFragment {
  readonly id: string;
  readonly idx: number;
  readonly createdAt: string;
  readonly canonicalText: string;
}

interface WebFindSnapshot {
  readonly mediaId: string;
  readonly sourceKey: PaneFindSourceKey;
  readonly fragments: readonly WebFindFragment[];
  readonly structure: ReaderDocumentStructure;
}

export interface WebFindRenderedState {
  readonly fragmentId: string;
  readonly canonicalText: string;
  readonly cursor: CanonicalCursorResult;
  readonly viewport: HTMLElement;
}

interface WebFindOccurrence {
  readonly key: PaneFindResultKey;
  readonly fragmentId: string;
  readonly startCp: number;
  readonly endCp: number;
}

interface PreparedSectionScope {
  readonly id: string;
  readonly startCp: number;
  readonly endCp: number;
}

export interface WebFindAdapter
  extends CanonicalTextFindAdapter<MediaPaneFindError> {
  resume(): void;
  invalidate(): void;
  dispose(): void;
}

type WebPaneFindSource =
  | { readonly kind: "Unavailable" }
  | {
      readonly kind: "Available";
      readonly mediaId: string;
      readonly fragments: readonly Fragment[];
      readonly sections: readonly ReaderNavigationSection[];
      readonly generation: number;
    };

type WebPaneFindCapability =
  | { readonly kind: "Unavailable" }
  | { readonly kind: "Available"; readonly adapter: WebFindAdapter };

function resolvePreparedWebSectionScope({ structure, fragmentId, anchorCp }: {
  readonly structure: ReaderDocumentStructure;
  readonly fragmentId: string;
  readonly anchorCp: number;
}): PreparedSectionScope | null {
  const section = readerSectionAtPosition(structure, readerTextPointOffset(structure, { fragment_id: fragmentId, offset: anchorCp }));
  return section.kind === "Present" && section.value.extent.kind === "Present"
    ? { id: `${CURRENT_SECTION_SCOPE_PREFIX}${section.value.section.section_id}`,
        startCp: section.value.extent.value.start, endCp: section.value.extent.value.end }
    : null;
}

function createWebFindSnapshot({
  mediaId,
  fragments,
  sections,
  generation,
}: {
  readonly mediaId: string;
  readonly fragments: readonly Fragment[];
  readonly sections: readonly ReaderNavigationSection[];
  readonly generation: number;
}): WebFindSnapshot {
  const ordered = [...fragments]
    .sort(
      (left, right) => left.idx - right.idx || left.id.localeCompare(right.id),
    )
    .map((fragment) => ({
      id: fragment.id,
      idx: fragment.idx,
      createdAt: fragment.created_at,
      canonicalText: fragment.canonical_text,
    }));
  return {
    mediaId,
    sourceKey: createPaneFindSourceKey({
      kind: "WebArticle",
      mediaId,
      generation,
      fragments: ordered.map(({ id, idx, createdAt }) => ({
        id,
        idx,
        createdAt,
      })),
    }),
    fragments: ordered,
    structure: buildReaderDocumentStructure({
      fragments: ordered.map((fragment) => ({ fragment_id: fragment.id, fragment_idx: fragment.idx, char_count: canonicalCpLength(fragment.canonicalText) })),
      sections: [...sections],
    }),
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException("Pane Find request was cancelled.", "AbortError");
  }
}

function assertRenderedFragment(
  snapshot: WebFindSnapshot,
  rendered: WebFindRenderedState,
): WebFindFragment {
  const fragment = snapshot.fragments.find(
    (candidate) => candidate.id === rendered.fragmentId,
  );
  if (
    !fragment ||
    rendered.canonicalText !== fragment.canonicalText ||
    !validateCanonicalText(rendered.cursor, fragment.canonicalText)
  ) {
    throw new Error("Web Find canonical DOM mismatch.");
  }
  return fragment;
}

function createWebFindAdapter({
  snapshot,
  getCurrentSourceKey,
  getRenderedState,
  readerNavigation,
  presentation,
}: {
  readonly snapshot: WebFindSnapshot;
  readonly getCurrentSourceKey: () => PaneFindSourceKey | null;
  readonly getRenderedState: () => WebFindRenderedState | null;
  readonly readerNavigation: ReaderTextFindNavigation;
  readonly presentation: CanonicalTextFindPresentationOwner;
}): WebFindAdapter {
  let preparedScopeBySession = new Map<number, PreparedSectionScope | null>();
  let occurrencesByKey = new Map<PaneFindResultKey, WebFindOccurrence>();
  let activeOccurrence: WebFindOccurrence | null = null;
  let disposed = false;
  const assertCurrent = (sourceKey: PaneFindSourceKey) => {
    if (
      disposed ||
      sourceKey !== snapshot.sourceKey ||
      sourceKey !== getCurrentSourceKey()
    ) {
      throw new DOMException("Web Find source was replaced.", "AbortError");
    }
  };

  const publishCurrentRanges = (rendered: WebFindRenderedState): void => {
    assertRenderedFragment(snapshot, rendered);
    presentation.publish({
      fragmentId: rendered.fragmentId,
      cursor: rendered.cursor,
      viewport: rendered.viewport,
      targets: [...occurrencesByKey.values()],
      activeKey: activeOccurrence?.key ?? null,
    });
  };
  const invalidate = (): void => {
    preparedScopeBySession.clear();
    occurrencesByKey.clear();
    activeOccurrence = null;
    presentation.clear();
  };

  return {
    sourceKey: snapshot.sourceKey,
    returnNavigation: { kind: "ReaderOwned" },
    async prepare(request) {
      assertCurrent(request.sourceKey);
      throwIfAborted(request.signal);
      const rendered = getRenderedState();
      let preparedScope: PreparedSectionScope | null = null;
      if (rendered) {
        assertRenderedFragment(snapshot, rendered);
        const anchorCp = findFirstVisibleCanonicalOffset(
          rendered.viewport,
          rendered.cursor,
        );
        if (anchorCp !== null) {
          preparedScope = resolvePreparedWebSectionScope({
            structure: snapshot.structure,
            fragmentId: rendered.fragmentId,
            anchorCp,
          });
        }
      }
      preparedScopeBySession = new Map([[request.sessionId, preparedScope]]);
      return [
        {
          kind: "EntireResource",
          id: ENTIRE_ARTICLE_SCOPE_ID,
          label: "Entire article",
        },
        ...(preparedScope
          ? [
              {
                kind: "Narrow" as const,
                id: preparedScope.id,
                label: "This section",
              },
            ]
          : []),
      ];
    },
    async find(request) {
      assertCurrent(request.sourceKey);
      throwIfAborted(request.signal);
      const preparedScope = preparedScopeBySession.get(request.sessionId);
      if (preparedScope === undefined) {
        throw new Error("Web Find session was not prepared.");
      }
      if (
        request.scopeId !== ENTIRE_ARTICLE_SCOPE_ID &&
        request.scopeId !== preparedScope?.id
      ) {
        throw new Error(`Unknown Web Find scope: ${request.scopeId}`);
      }
      const scoped =
        request.scopeId === preparedScope?.id ? preparedScope : null;
      const unitBaseOffsets = new Map<string, number>();
      const units = snapshot.fragments.flatMap((fragment) => {
        const fragmentStart = readerTextPointOffset(snapshot.structure, { fragment_id: fragment.id, offset: 0 });
        const fragmentLength = canonicalCpLength(fragment.canonicalText);
        const base = scoped ? Math.max(0, scoped.startCp - fragmentStart) : 0;
        const end = scoped ? Math.min(fragmentLength, scoped.endCp - fragmentStart) : fragmentLength;
        if (end <= base) return [];
        unitBaseOffsets.set(fragment.id, base);
        return [
          {
            id: fragment.id,
            text: scoped
              ? Array.from(fragment.canonicalText)
                  .slice(base, end)
                  .join("")
              : fragment.canonicalText,
          },
        ];
      });
      const result = canonicalTextFind({
        units,
        query: request.query,
        matchCase: request.matchCase,
        wholeWord: request.wholeWord,
        completeness: "Complete",
      });
      activeOccurrence = null;
      occurrencesByKey = new Map();
      if (result.kind === "NoMatches") {
        return {
          kind: "NoMatches",
          completeness: "Complete",
        };
      }
      if (result.kind === "TooManyMatches") {
        return {
          kind: "TooManyMatches",
          threshold: result.threshold,
        };
      }
      const rows = result.occurrences.map((match) => {
        const startCp =
          (unitBaseOffsets.get(match.unitId) ?? 0) + match.startCp;
        const endCp = (unitBaseOffsets.get(match.unitId) ?? 0) + match.endCp;
        const key = createPaneFindResultKey({
          source: {
            kind: "WebArticleFragment",
            mediaId: snapshot.mediaId,
            fragmentId: match.unitId,
          },
          locator: {
            kind: "FragmentRange",
            fragmentId: match.unitId,
            startCp,
            endCp,
          },
        });
        const occurrence = {
          key,
          fragmentId: match.unitId,
          startCp,
          endCp,
        };
        occurrencesByKey.set(key, occurrence);
        const section = readerSectionAtPosition(snapshot.structure,
          readerTextPointOffset(snapshot.structure, { fragment_id: match.unitId, offset: startCp }));
        return {
          key,
          context: section.kind === "Present" ? [section.value.section.label] : [],
          snippet: match.snippet,
        };
      });
      const initial = rows[0];
      if (!initial) {
        throw new Error("Web Find Ready requires at least one occurrence.");
      }
      return {
        kind: "Ready",
        completeness: "Complete",
        rows,
        initialActiveKey: initial.key,
      };
    },
    async preview(request): Promise<PaneFindPreviewReceipt<MediaPaneFindError>> {
      assertCurrent(request.sourceKey);
      throwIfAborted(request.signal);
      const occurrence = occurrencesByKey.get(request.key);
      if (!occurrence) throw new Error("Web Find occurrence is no longer available.");
      const outcome = await readerNavigation.inspect({
        fragmentId: occurrence.fragmentId,
        startOffset: occurrence.startCp,
        endOffset: occurrence.endCp,
      }, request.signal);
      throwIfAborted(request.signal);
      assertCurrent(request.sourceKey);
      if (outcome.kind === "Cancelled") {
        throw new DOMException("Web Find preview was cancelled.", "AbortError");
      }
      if (outcome.kind === "Unavailable") {
        return { kind: "Rejected", error: { kind: outcome.reason === "CaptureUnavailable" ? "OriginUnavailable" : "RequestUnavailable" } };
      }
      const rendered = getRenderedState();
      if (!rendered || rendered.fragmentId !== occurrence.fragmentId) {
        throw new Error("Web Find navigation arrived without its rendered fragment.");
      }
      activeOccurrence = occurrence;
      publishCurrentRanges(rendered);
      return { kind: "Previewed" };
    },
    async clearPresentation(request) {
      assertCurrent(request.sourceKey);
      activeOccurrence = null;
      presentation.clear();
    },
    errorMessage: mediaPaneFindErrorMessage,
    rebuildPresentation() {
      const rendered = getRenderedState();
      if (!rendered || activeOccurrence === null) {
        presentation.clear();
        return;
      }
      publishCurrentRanges(rendered);
    },
    resume() {
      disposed = false;
    },
    invalidate,
    dispose() {
      if (disposed) return;
      invalidate();
      disposed = true;
    },
  };
}

export function useWebPaneFindCapability({
  source,
  renderedStateRef,
  readerNavigation,
}: {
  readonly source: WebPaneFindSource;
  readonly renderedStateRef: RefObject<WebFindRenderedState | null>;
  readonly readerNavigation: ReaderTextFindNavigation;
}): WebPaneFindCapability {
  const sourceMediaId = source.kind === "Available" ? source.mediaId : null;
  const sourceFragments = source.kind === "Available" ? source.fragments : null;
  const sourceSections = source.kind === "Available" ? source.sections : null;
  const sourceGeneration = source.kind === "Available" ? source.generation : null;
  const snapshot = useMemo(
    () => sourceMediaId !== null && sourceFragments !== null &&
      sourceSections !== null && sourceGeneration !== null
      ? createWebFindSnapshot({
          mediaId: sourceMediaId, fragments: sourceFragments,
          sections: sourceSections, generation: sourceGeneration,
        })
      : null,
    [sourceFragments, sourceMediaId, sourceSections, sourceGeneration],
  );
  const sourceKeyRef = useRef<PaneFindSourceKey | null>(null);
  sourceKeyRef.current = snapshot?.sourceKey ?? null;
  const navigationRef = useRef(readerNavigation);
  navigationRef.current = readerNavigation;
  const presentation = useMemo(() => createCanonicalTextFindPresentationOwner(), []);
  const adapter = useMemo(() => snapshot === null ? null : createWebFindAdapter({
    snapshot,
    getCurrentSourceKey: () => sourceKeyRef.current,
    getRenderedState: () => renderedStateRef.current,
    readerNavigation: { inspect: (target, signal) => navigationRef.current.inspect(target, signal) },
    presentation,
  }), [presentation, renderedStateRef, snapshot]);
  useLayoutEffect(() => {
    if (!adapter) return;
    adapter.resume();
    return () => adapter.dispose();
  }, [adapter]);
  return useMemo(() => adapter === null
    ? { kind: "Unavailable" } : { kind: "Available", adapter }, [adapter]);
}
