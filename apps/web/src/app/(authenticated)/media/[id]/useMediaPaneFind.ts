"use client";

import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import {
  validateCanonicalText,
  type CanonicalCursorResult,
} from "@/lib/highlights/canonicalCursor";
import type { Fragment } from "@/lib/media/transcriptView";
import type { ReaderNavigationSection } from "@/lib/media/readerNavigation";
import {
  createPaneFindResultKey,
  createPaneFindSourceKey,
  type PaneFindResultKey,
  type PaneFindSourceKey,
} from "@/lib/panes/paneSearch";
import {
  type PaneFindAdapter,
  type PaneFindPreviewReceipt,
} from "@/lib/panes/usePaneFind";
import { canonicalTextFind } from "@/lib/reader/canonicalTextFind";
import {
  createCanonicalTextFindHighlightOwner,
  type CanonicalTextFindHighlightOwner,
} from "@/lib/reader/canonicalTextFindHighlights";
import {
  findFirstVisibleCanonicalOffset,
  measureCanonicalTextAnchorViewportDelta,
  resolveCanonicalTextRanges,
  restoreCanonicalTextAnchorViewportPosition,
  scrollToExactCanonicalTextAnchor,
} from "./paneTextAnchor";
import type { MediaFindPreviewLease } from "./mediaFindPreviewLease";
import {
  mediaPaneFindErrorMessage,
  type MediaPaneFindError,
} from "./mediaPaneFind";

const ENTIRE_ARTICLE_SCOPE_ID = "EntireArticle";
const CURRENT_SECTION_SCOPE_PREFIX = "CurrentSection:";
const RENDER_ATTEMPT_LIMIT = 48;
interface WebFindFragment {
  readonly id: string;
  readonly idx: number;
  readonly createdAt: string;
  readonly canonicalText: string;
}

export interface WebFindSnapshot {
  readonly mediaId: string;
  readonly sourceKey: PaneFindSourceKey;
  readonly fragments: readonly WebFindFragment[];
  readonly sections: readonly ReaderNavigationSection[];
}

export interface WebFindRenderedState {
  readonly fragmentId: string;
  readonly canonicalText: string;
  readonly cursor: CanonicalCursorResult;
  readonly viewport: HTMLElement;
}

export interface WebFindOrigin {
  readonly fragmentId: string;
  readonly anchorCp: number;
  readonly viewportTopDeltaPx: number;
  readonly scrollLeft: number;
}

interface WebFindOccurrence {
  readonly key: PaneFindResultKey;
  readonly fragmentId: string;
  readonly startCp: number;
  readonly endCp: number;
}

interface PreparedSectionScope {
  readonly id: string;
  readonly fragmentId: string;
  readonly startCp: number;
  readonly endCp: number;
}

export interface WebFindAdapter extends PaneFindAdapter<MediaPaneFindError> {
  rebuildPresentation(): void;
  dispose(): void;
}

export type WebPaneFindSource =
  | { readonly kind: "Unavailable" }
  | {
      readonly kind: "Available";
      readonly mediaId: string;
      readonly fragments: readonly Fragment[];
      readonly sections: readonly ReaderNavigationSection[];
    };

export type WebPaneFindCapability =
  | { readonly kind: "Unavailable" }
  | { readonly kind: "Available"; readonly adapter: WebFindAdapter };

function sectionBounds(
  section: ReaderNavigationSection,
): { startCp: number; endCp: number } | null {
  const { start_offset: startCp, end_offset: endCp } = section;
  return Number.isInteger(startCp) &&
    Number.isInteger(endCp) &&
    startCp !== null &&
    endCp !== null &&
    startCp >= 0 &&
    endCp > startCp
    ? { startCp, endCp }
    : null;
}

function sectionSpecificity(section: ReaderNavigationSection): number {
  return section.depth ?? section.level ?? 0;
}

function containingSection({
  sections,
  fragmentId,
  startCp,
  endCp,
}: {
  readonly sections: readonly ReaderNavigationSection[];
  readonly fragmentId: string;
  readonly startCp: number;
  readonly endCp: number;
}): ReaderNavigationSection | null {
  return (
    sections
      .filter((section) => {
        const bounds = sectionBounds(section);
        return (
          section.fragment_id === fragmentId &&
          bounds !== null &&
          startCp >= bounds.startCp &&
          (startCp === endCp ? startCp < bounds.endCp : endCp <= bounds.endCp)
        );
      })
      .sort((left, right) => {
        const leftBounds = sectionBounds(left)!;
        const rightBounds = sectionBounds(right)!;
        return (
          sectionSpecificity(right) - sectionSpecificity(left) ||
          leftBounds.endCp -
            leftBounds.startCp -
            (rightBounds.endCp - rightBounds.startCp) ||
          left.ordinal - right.ordinal
        );
      })[0] ?? null
  );
}

export function resolvePreparedWebSectionScope({
  sections,
  fragmentId,
  anchorCp,
  fragmentLengthCp,
}: {
  readonly sections: readonly ReaderNavigationSection[];
  readonly fragmentId: string;
  readonly anchorCp: number;
  readonly fragmentLengthCp: number;
}): PreparedSectionScope | null {
  const section = containingSection({
    sections,
    fragmentId,
    startCp: anchorCp,
    endCp: anchorCp,
  });
  const bounds = section ? sectionBounds(section) : null;
  return section &&
    bounds &&
    bounds.startCp < fragmentLengthCp &&
    bounds.endCp <= fragmentLengthCp
    ? {
        id: `${CURRENT_SECTION_SCOPE_PREFIX}${section.section_id}`,
        fragmentId,
        startCp: bounds.startCp,
        endCp: bounds.endCp,
      }
    : null;
}

export function createWebFindSnapshot({
  mediaId,
  fragments,
  sections,
}: {
  readonly mediaId: string;
  readonly fragments: readonly Fragment[];
  readonly sections: readonly ReaderNavigationSection[];
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
      fragments: ordered.map(({ id, idx, createdAt }) => ({
        id,
        idx,
        createdAt,
      })),
    }),
    fragments: ordered,
    sections: [...sections],
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException("Pane Find request was cancelled.", "AbortError");
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
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
    !validateCanonicalText(rendered.cursor, fragment.canonicalText, fragment.id)
  ) {
    throw new Error("Web Find canonical DOM mismatch.");
  }
  return fragment;
}

function captureOrigin(
  snapshot: WebFindSnapshot,
  rendered: WebFindRenderedState | null,
): WebFindOrigin | null {
  if (!rendered) return null;
  assertRenderedFragment(snapshot, rendered);
  const anchorCp = findFirstVisibleCanonicalOffset(
    rendered.viewport,
    rendered.cursor,
  );
  if (anchorCp === null) return null;
  const viewportTopDeltaPx = measureCanonicalTextAnchorViewportDelta(
    rendered.viewport,
    rendered.cursor,
    anchorCp,
  );
  return viewportTopDeltaPx === null
    ? null
    : {
        fragmentId: rendered.fragmentId,
        anchorCp,
        viewportTopDeltaPx,
        scrollLeft: rendered.viewport.scrollLeft,
      };
}

export function createWebFindAdapter({
  snapshot,
  getCurrentSourceKey,
  getRenderedState,
  showPreviewFragment,
  clearPreviewFragment,
  focusReaderViewport,
  previewLease,
  highlightOwner,
}: {
  readonly snapshot: WebFindSnapshot;
  readonly getCurrentSourceKey: () => PaneFindSourceKey | null;
  readonly getRenderedState: () => WebFindRenderedState | null;
  readonly showPreviewFragment: (
    fragmentId: string,
    signal: AbortSignal,
  ) => Promise<WebFindRenderedState>;
  readonly clearPreviewFragment: () => void;
  readonly focusReaderViewport: () => void;
  readonly previewLease: MediaFindPreviewLease;
  readonly highlightOwner: CanonicalTextFindHighlightOwner;
}): WebFindAdapter {
  let preparedScopeBySession = new Map<number, PreparedSectionScope | null>();
  let occurrencesByKey = new Map<PaneFindResultKey, WebFindOccurrence>();
  let activeOccurrence: WebFindOccurrence | null = null;
  let origin: WebFindOrigin | null = null;
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

  const publishRenderedRanges = (rendered: WebFindRenderedState): void => {
    assertRenderedFragment(snapshot, rendered);
    const visibleOccurrences = [...occurrencesByKey.values()].filter(
      (occurrence) => occurrence.fragmentId === rendered.fragmentId,
    );
    const resolveOccurrence = (occurrence: WebFindOccurrence) => {
      const ranges = resolveCanonicalTextRanges(
        rendered.cursor,
        occurrence.startCp,
        occurrence.endCp,
      );
      if (!ranges) {
        throw new Error("Web Find occurrence is not exactly renderable.");
      }
      return ranges;
    };
    highlightOwner.publish({
      all: visibleOccurrences.flatMap(resolveOccurrence),
      active:
        activeOccurrence?.fragmentId === rendered.fragmentId
          ? resolveOccurrence(activeOccurrence)
          : [],
    });
  };

  return {
    sourceKey: snapshot.sourceKey,
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
            sections: snapshot.sections,
            fragmentId: rendered.fragmentId,
            anchorCp,
            fragmentLengthCp: Array.from(rendered.canonicalText).length,
          });
        }
      }
      preparedScopeBySession = new Map([[request.sessionId, preparedScope]]);
      return {
        sessionId: request.sessionId,
        sourceKey: request.sourceKey,
        scopes: [
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
        ],
      };
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
        if (scoped && fragment.id !== scoped.fragmentId) return [];
        const base = scoped?.startCp ?? 0;
        unitBaseOffsets.set(fragment.id, base);
        return [
          {
            id: fragment.id,
            text: scoped
              ? Array.from(fragment.canonicalText)
                  .slice(scoped.startCp, scoped.endCp)
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
          sessionId: request.sessionId,
          queryId: request.queryId,
          sourceKey: request.sourceKey,
          completeness: "Complete",
        };
      }
      if (result.kind === "TooManyMatches") {
        return {
          kind: "TooManyMatches",
          sessionId: request.sessionId,
          queryId: request.queryId,
          sourceKey: request.sourceKey,
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
        const section = containingSection({
          sections: snapshot.sections,
          fragmentId: match.unitId,
          startCp,
          endCp,
        });
        return {
          key,
          context: section?.label ? [section.label] : [],
          snippet: match.snippet,
        };
      });
      const initial = rows[0];
      if (!initial) {
        throw new Error("Web Find Ready requires at least one occurrence.");
      }
      return {
        kind: "Ready",
        sessionId: request.sessionId,
        queryId: request.queryId,
        sourceKey: request.sourceKey,
        completeness: "Complete",
        rows,
        initialActiveKey: initial.key,
      };
    },
    async preview(
      request,
    ): Promise<PaneFindPreviewReceipt<MediaPaneFindError>> {
      assertCurrent(request.sourceKey);
      throwIfAborted(request.signal);
      const occurrence = occurrencesByKey.get(request.key);
      if (!occurrence) {
        throw new Error("Web Find occurrence is no longer available.");
      }
      const originWasNew = origin === null;
      const candidateOrigin =
        origin ?? captureOrigin(snapshot, getRenderedState());
      if (!candidateOrigin) {
        return {
          kind: "Rejected",
          sessionId: request.sessionId,
          queryId: request.queryId,
          sourceKey: request.sourceKey,
          key: request.key,
          error: { kind: "OriginUnavailable" },
        };
      }
      origin ??= candidateOrigin;
      previewLease.acquire();
      try {
        const rendered = await showPreviewFragment(
          occurrence.fragmentId,
          request.signal,
        );
        assertCurrent(request.sourceKey);
        assertRenderedFragment(snapshot, rendered);
        if (request.signal.aborted) {
          // The fragment switch itself is already a reversible move. Settle a
          // receipt so the foundation retains Return, but never repaint marks
          // that Close has concurrently cleared.
          return {
            kind: "Previewed",
            sessionId: request.sessionId,
            queryId: request.queryId,
            sourceKey: request.sourceKey,
            key: request.key,
            returnAvailable: true,
          };
        }
        activeOccurrence = occurrence;
        publishRenderedRanges(rendered);
        if (
          !scrollToExactCanonicalTextAnchor(
            rendered.viewport,
            rendered.cursor,
            occurrence.startCp,
          )
        ) {
          throw new Error("Web Find occurrence anchor is not renderable.");
        }
      } catch (error) {
        if (disposed) {
          origin = null;
          throw new DOMException("Web Find source was replaced.", "AbortError");
        }
        activeOccurrence = null;
        highlightOwner.clear();
        if (isAbort(error) && originWasNew) {
          const current = getRenderedState();
          if (current?.fragmentId === occurrence.fragmentId) {
            assertRenderedFragment(snapshot, current);
            return {
              kind: "Previewed",
              sessionId: request.sessionId,
              queryId: request.queryId,
              sourceKey: request.sourceKey,
              key: request.key,
              returnAvailable: true,
            };
          }
          const restoreSignal = new AbortController().signal;
          await showPreviewFragment(candidateOrigin.fragmentId, restoreSignal);
          clearPreviewFragment();
          origin = null;
          previewLease.cancelUnreportedPreview();
          throw error;
        }
        if (occurrence.fragmentId !== candidateOrigin.fragmentId) {
          await showPreviewFragment(
            candidateOrigin.fragmentId,
            new AbortController().signal,
          );
          clearPreviewFragment();
        }
        if (originWasNew) {
          origin = null;
          previewLease.cancelUnreportedPreview();
        }
        throw error;
      }
      return {
        kind: "Previewed",
        sessionId: request.sessionId,
        queryId: request.queryId,
        sourceKey: request.sourceKey,
        key: request.key,
        returnAvailable: true,
      };
    },
    async clearPresentation(request) {
      assertCurrent(request.sourceKey);
      highlightOwner.clear();
    },
    async returnToReadingPosition(request) {
      assertCurrent(request.sourceKey);
      throwIfAborted(request.signal);
      if (!origin) return;
      previewLease.acquire();
      const rendered = await showPreviewFragment(
        origin.fragmentId,
        request.signal,
      );
      throwIfAborted(request.signal);
      assertCurrent(request.sourceKey);
      assertRenderedFragment(snapshot, rendered);
      if (
        !restoreCanonicalTextAnchorViewportPosition(
          rendered.viewport,
          rendered.cursor,
          origin.anchorCp,
          origin.viewportTopDeltaPx,
          origin.scrollLeft,
        )
      ) {
        throw new Error("Web Find reading origin is no longer renderable.");
      }
      activeOccurrence = null;
      highlightOwner.clear();
      origin = null;
      clearPreviewFragment();
      focusReaderViewport();
      previewLease.completeReturn();
    },
    errorMessage: mediaPaneFindErrorMessage,
    rebuildPresentation() {
      const rendered = getRenderedState();
      if (rendered && occurrencesByKey.size > 0) {
        publishRenderedRanges(rendered);
      }
    },
    dispose() {
      disposed = true;
      preparedScopeBySession.clear();
      occurrencesByKey.clear();
      activeOccurrence = null;
      origin = null;
      highlightOwner.clear();
      previewLease.retire();
    },
  };
}

async function waitForRenderedFragment({
  fragmentId,
  snapshot,
  signal,
  getRenderedState,
}: {
  readonly fragmentId: string;
  readonly snapshot: WebFindSnapshot;
  readonly signal: AbortSignal;
  readonly getRenderedState: () => WebFindRenderedState | null;
}): Promise<WebFindRenderedState> {
  for (let attempt = 0; attempt < RENDER_ATTEMPT_LIMIT; attempt += 1) {
    throwIfAborted(signal);
    const rendered = getRenderedState();
    if (rendered?.fragmentId === fragmentId) {
      assertRenderedFragment(snapshot, rendered);
      return rendered;
    }
    await new Promise<void>((resolve) =>
      window.requestAnimationFrame(() => resolve()),
    );
  }
  throw new Error("Web Find preview fragment did not render.");
}

export function useWebPaneFindCapability({
  source,
  renderedStateRef,
  previewFragmentId,
  setPreviewFragmentId,
  focusReaderViewport,
  previewLease,
}: {
  readonly source: WebPaneFindSource;
  readonly renderedStateRef: RefObject<WebFindRenderedState | null>;
  readonly previewFragmentId: string | null;
  readonly setPreviewFragmentId: Dispatch<SetStateAction<string | null>>;
  readonly focusReaderViewport: () => void;
  readonly previewLease: MediaFindPreviewLease;
}): WebPaneFindCapability {
  const sourceMediaId = source.kind === "Available" ? source.mediaId : null;
  const sourceFragments = source.kind === "Available" ? source.fragments : null;
  const sourceSections = source.kind === "Available" ? source.sections : null;
  const snapshot = useMemo(
    () =>
      sourceMediaId !== null &&
      sourceFragments !== null &&
      sourceSections !== null
        ? createWebFindSnapshot({
            mediaId: sourceMediaId,
            fragments: sourceFragments,
            sections: sourceSections,
          })
        : null,
    [sourceFragments, sourceMediaId, sourceSections],
  );
  const findSnapshotRef = useRef<WebFindSnapshot | null>(snapshot);
  if (snapshot === null) {
    findSnapshotRef.current = null;
  } else if (
    previewFragmentId === null ||
    findSnapshotRef.current === null ||
    findSnapshotRef.current.sourceKey === snapshot.sourceKey
  ) {
    findSnapshotRef.current = snapshot;
  }
  const findSnapshot = findSnapshotRef.current;
  const sourceKeyRef = useRef<PaneFindSourceKey | null>(
    snapshot?.sourceKey ?? null,
  );
  sourceKeyRef.current = snapshot?.sourceKey ?? null;
  const highlightOwner = useMemo(
    () => createCanonicalTextFindHighlightOwner(),
    [],
  );
  const getRenderedState = useCallback(
    () => renderedStateRef.current,
    [renderedStateRef],
  );
  const showPreviewFragment = useCallback(
    async (fragmentId: string, signal: AbortSignal) => {
      if (findSnapshot === null) {
        throw new DOMException("Web Find source was replaced.", "AbortError");
      }
      setPreviewFragmentId(fragmentId);
      return waitForRenderedFragment({
        fragmentId,
        snapshot: findSnapshot,
        signal,
        getRenderedState,
      });
    },
    [findSnapshot, getRenderedState, setPreviewFragmentId],
  );
  const adapter = useMemo(
    () =>
      findSnapshot === null
        ? null
        : createWebFindAdapter({
            snapshot: findSnapshot,
            getCurrentSourceKey: () => sourceKeyRef.current,
            getRenderedState,
            showPreviewFragment,
            clearPreviewFragment: () => setPreviewFragmentId(null),
            focusReaderViewport,
            previewLease,
            highlightOwner,
          }),
    [
      focusReaderViewport,
      getRenderedState,
      highlightOwner,
      previewLease,
      setPreviewFragmentId,
      showPreviewFragment,
      findSnapshot,
    ],
  );
  const capability = useMemo<WebPaneFindCapability>(
    () =>
      adapter === null
        ? { kind: "Unavailable" }
        : { kind: "Available", adapter },
    [adapter],
  );
  const begunWebAdapterRef = useRef<WebFindAdapter | null>(null);
  useLayoutEffect(() => {
    if (
      previewFragmentId !== null &&
      (findSnapshot === null ||
        snapshot === null ||
        findSnapshot.sourceKey !== snapshot.sourceKey)
    ) {
      setPreviewFragmentId(null);
    }
  }, [findSnapshot, previewFragmentId, setPreviewFragmentId, snapshot]);
  useLayoutEffect(() => {
    if (adapter === null) return;
    setPreviewFragmentId(null);
    return () => adapter.dispose();
  }, [adapter, setPreviewFragmentId]);
  useLayoutEffect(() => {
    if (
      adapter === null ||
      previewFragmentId !== null ||
      begunWebAdapterRef.current === adapter
    ) {
      return;
    }
    begunWebAdapterRef.current = adapter;
    previewLease.beginSource();
  }, [adapter, previewFragmentId, previewLease]);
  return capability;
}
