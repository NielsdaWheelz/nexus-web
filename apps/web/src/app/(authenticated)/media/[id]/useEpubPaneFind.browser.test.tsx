import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { buildCanonicalCursor } from "@/lib/highlights/canonicalCursor";
import {
  createEpubFindSnapshot,
  type EpubFindOccurrenceOut,
  type EpubFindRequest,
  type EpubFindResultOut,
  type EpubSectionContent,
} from "@/lib/media/epubFind";
import type {
  ReaderNavigationFragment,
  ReaderNavigationSection,
} from "@/lib/media/readerNavigation";
import type { PaneFindSourceKey } from "@/lib/panes/paneSearch";
import { usePaneFind } from "@/lib/panes/usePaneFind";
import type { ReaderScrollPositioner } from "@/lib/reader/paneScroll";
import { createMediaFindPreviewLease } from "./mediaFindPreviewLease";
import {
  createEpubFindAdapter,
  useEpubPaneFind,
  type EpubFindRenderedState,
  type EpubRenderedSectionOverride,
} from "./useEpubPaneFind";

const scrollPositioner: ReaderScrollPositioner = {
  async run(operation) {
    await operation({
      setTop(scrollport, top) {
        scrollport.scrollTop = Math.max(0, top);
      },
      adjustTop(scrollport, delta) {
        scrollport.scrollTop = Math.max(0, scrollport.scrollTop + delta);
      },
      reveal() {},
    });
  },
};

const MEDIA_ID = "00000000-0000-4000-8000-000000000001";
const FIRST_FRAGMENT = "10000000-0000-4000-8000-000000000001";
const SECOND_FRAGMENT = "20000000-0000-4000-8000-000000000002";
const THIRD_FRAGMENT = "30000000-0000-4000-8000-000000000003";

interface EpubFindInvocation {
  readonly mediaId: string;
  readonly request: EpubFindRequest;
  readonly signal: AbortSignal;
}

function cpLength(value: string): number {
  return [...value].length;
}

function navigationSection({
  sectionId,
  label,
  ordinal,
  fragmentId,
  canonicalText: _canonicalText,
}: {
  readonly sectionId: string;
  readonly label: string;
  readonly ordinal: number;
  readonly fragmentId: string;
  readonly canonicalText: string;
}): ReaderNavigationSection {
  return {
    section_id: sectionId,
    label,
    ordinal,
    fragment_id: fragmentId,
    fragment_idx: ordinal,
    level: null,
    depth: null,
    start_offset: 0,
    end_offset: null,
    href_path: `chapter-${ordinal + 1}.xhtml`,
    href_fragment: null,
    anchor_id: null,
  };
}

function sectionContent({
  sectionId,
  label,
  ordinal,
  fragmentId,
  canonicalText,
}: {
  readonly sectionId: string;
  readonly label: string;
  readonly ordinal: number;
  readonly fragmentId: string;
  readonly canonicalText: string;
}): EpubSectionContent {
  return {
    section_id: sectionId,
    label,
    fragment_id: fragmentId,
    fragment_idx: ordinal,
    href_path: `chapter-${ordinal + 1}.xhtml`,
    anchor_id: null,
    source_node_id: null,
    source: "spine",
    ordinal,
    prev_section_id: ordinal === 0 ? null : `section-${ordinal}`,
    next_section_id: ordinal === 2 ? null : `section-${ordinal + 2}`,
    html_sanitized: `<p>${canonicalText}</p>`,
    canonical_text: canonicalText,
    char_count: cpLength(canonicalText),
    word_count: canonicalText.split(/\s+/u).length,
    document_word_start: ordinal * 2,
    created_at: `2026-07-${String(ordinal + 1).padStart(2, "0")}T00:00:00Z`,
  };
}

function findSnapshot(sections: readonly EpubSectionContent[]) {
  const fragments: ReaderNavigationFragment[] = sections.map((section) => ({
    fragment_id: section.fragment_id,
    fragment_idx: section.fragment_idx,
    char_count: section.char_count,
  }));
  return createEpubFindSnapshot({
    mediaId: MEDIA_ID,
    fragments,
    navigation: sections.map((section) =>
      navigationSection({
        sectionId: section.section_id,
        label: section.label,
        ordinal: section.ordinal,
        fragmentId: section.fragment_id,
        canonicalText: section.canonical_text,
      }),
    ),
  });
}

function readerViewState(
  section: EpubSectionContent,
  scrollLeft = 0,
): EpubFindRenderedState {
  const root = document.createElement("div");
  root.innerHTML = section.html_sanitized;
  // Detached canonical-DOM fixture; no Testing Library query owns this node.
  // eslint-disable-next-line testing-library/no-node-access
  root.querySelector("p")!.getBoundingClientRect = () =>
    ({
      top: 50,
      bottom: 80,
      left: 10,
      right: 300,
      width: 290,
      height: 30,
    }) as DOMRect;
  const viewport = document.createElement("div");
  Object.defineProperty(viewport, "scrollTop", {
    configurable: true,
    writable: true,
    value: 100,
  });
  Object.defineProperty(viewport, "scrollLeft", {
    configurable: true,
    writable: true,
    value: scrollLeft,
  });
  viewport.getBoundingClientRect = () =>
    ({
      top: 0,
      bottom: 500,
      left: 0,
      right: 400,
      width: 400,
      height: 500,
    }) as DOMRect;
  return {
    section,
    cursor: buildCanonicalCursor(root),
    viewport,
  };
}

function occurrence(
  section: EpubSectionContent,
  startOffset: number,
  endOffset: number,
): EpubFindOccurrenceOut {
  return {
    section_id: section.section_id,
    section_label: section.label,
    fragment_id: section.fragment_id,
    fragment_idx: section.fragment_idx,
    start_offset: startOffset,
    end_offset: endOffset,
    snippet: [
      { text: section.canonical_text.slice(startOffset, endOffset), emphasized: true },
    ],
  };
}

function ready(
  witness: string,
  occurrences: readonly EpubFindOccurrenceOut[],
): EpubFindResultOut {
  return {
    kind: "Ready",
    source_witness_fragment_id: witness,
    occurrences,
  };
}

function findRequest(sourceKey: PaneFindSourceKey, queryId = 1) {
  return {
    sessionId: 1,
    queryId,
    sourceKey,
    signal: new AbortController().signal,
    query: "needle",
    scopeId: "EntireBook",
    matchCase: false,
    wholeWord: false,
  };
}

beforeEach(() => {
  vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue({
    top: 70,
    bottom: 88,
    left: 10,
    right: 20,
    width: 10,
    height: 18,
  } as DOMRect);
});

describe("EPUB Find adapter", () => {
  it("freezes book scopes, nominates the nearest-forward row, and previews the rendered section without fetching", async () => {
    const first = sectionContent({
      sectionId: "section-1",
      label: "Opening",
      ordinal: 0,
      fragmentId: FIRST_FRAGMENT,
      canonicalText: "Opening needle",
    });
    const second = sectionContent({
      sectionId: "section-2",
      label: "Later",
      ordinal: 1,
      fragmentId: SECOND_FRAGMENT,
      canonicalText: "Later needle",
    });
    const snapshot = findSnapshot([first, second]);
    const readerState = readerViewState(second);
    const loadSection = vi.fn();
    const highlightOwner = { publish: vi.fn(), clear: vi.fn() };
    const setAwaitingReaderAdoption = vi.fn();
    const resetRenderedSectionAuxiliaryState = vi.fn();
    const adapter = createEpubFindAdapter({
      snapshot,
      getCurrentSourceKey: () => snapshot.sourceKey,
      getRenderedState: () => readerState,
      getRenderedSectionOverride: () => null,
      setRenderedSectionOverride: vi.fn(),
      previewLease: createMediaFindPreviewLease(),
      setAwaitingReaderAdoption,
      resetRenderedSectionAuxiliaryState,
      onSourceChanged: vi.fn(),
      focusReaderViewport: vi.fn(),
      highlightOwner,
      scrollPositioner,
      findOccurrences: vi.fn(async () =>
        ready(snapshot.sourceWitnessFragmentId, [
          occurrence(first, 8, 14),
          occurrence(second, 6, 12),
        ]),
      ),
      loadSection,
    });
    const signal = new AbortController().signal;
    const prepared = await adapter.prepare({
      sessionId: 1,
      sourceKey: snapshot.sourceKey,
      signal,
    });
    expect(prepared.scopes).toEqual([
      { kind: "EntireResource", id: "EntireBook", label: "Entire book" },
      {
        kind: "Narrow",
        id: "CurrentSection:section-2",
        label: "This section",
      },
    ]);

    const response = await adapter.find(findRequest(snapshot.sourceKey));
    if (response.kind !== "Ready") throw new Error("expected Ready");
    expect(response.initialActiveKey).toBe(response.rows[1]!.key);

    await expect(
      adapter.preview({
        sessionId: 1,
        queryId: 1,
        sourceKey: snapshot.sourceKey,
        signal,
        key: response.rows[1]!.key,
      }),
    ).resolves.toMatchObject({
      kind: "Previewed",
      key: response.rows[1]!.key,
    });
    expect(loadSection).not.toHaveBeenCalled();
    expect(resetRenderedSectionAuxiliaryState).not.toHaveBeenCalled();
    expect(highlightOwner.publish).toHaveBeenCalledWith({
      all: expect.arrayContaining([expect.any(Range)]),
      active: expect.arrayContaining([expect.any(Range)]),
    });
    expect(setAwaitingReaderAdoption).toHaveBeenLastCalledWith(true);
  });

  it("previews a fetched section and returns to the immutable origin without refetching it", async () => {
    const first = sectionContent({
      sectionId: "section-1",
      label: "Opening",
      ordinal: 0,
      fragmentId: FIRST_FRAGMENT,
      canonicalText: "Opening text",
    });
    const second = sectionContent({
      sectionId: "section-2",
      label: "Later",
      ordinal: 1,
      fragmentId: SECOND_FRAGMENT,
      canonicalText: "Later needle",
    });
    const snapshot = findSnapshot([first, second]);
    let readerState = readerViewState(first, 27);
    let override: EpubRenderedSectionOverride | null = null;
    const setRenderedSectionOverride = vi.fn(
      (next: EpubRenderedSectionOverride | null) => {
        override = next;
        if (next) readerState = readerViewState(next.section);
      },
    );
    const loadSection = vi.fn(async () => second);
    const resetRenderedSectionAuxiliaryState = vi.fn();
    const focusReaderViewport = vi.fn();
    const highlightOwner = { publish: vi.fn(), clear: vi.fn() };
    const adapter = createEpubFindAdapter({
      snapshot,
      getCurrentSourceKey: () => snapshot.sourceKey,
      getRenderedState: () => readerState,
      getRenderedSectionOverride: () => override,
      setRenderedSectionOverride,
      previewLease: createMediaFindPreviewLease(),
      setAwaitingReaderAdoption: vi.fn(),
      resetRenderedSectionAuxiliaryState,
      onSourceChanged: vi.fn(),
      focusReaderViewport,
      highlightOwner,
      scrollPositioner,
      findOccurrences: vi.fn(async () =>
        ready(snapshot.sourceWitnessFragmentId, [
          occurrence(second, 6, 12),
        ]),
      ),
      loadSection,
    });
    const signal = new AbortController().signal;
    await adapter.prepare({
      sessionId: 1,
      sourceKey: snapshot.sourceKey,
      signal,
    });
    const response = await adapter.find(findRequest(snapshot.sourceKey));
    if (response.kind !== "Ready") throw new Error("expected Ready");

    await adapter.preview({
      sessionId: 1,
      queryId: 1,
      sourceKey: snapshot.sourceKey,
      signal,
      key: response.rows[0]!.key,
    });
    expect(override).toMatchObject({
      kind: "FindPreview",
      section: { section_id: second.section_id },
    });

    await adapter.returnToReadingPosition({
      sessionId: 1,
      sourceKey: snapshot.sourceKey,
      signal,
    });
    expect(loadSection).toHaveBeenCalledTimes(1);
    expect(resetRenderedSectionAuxiliaryState).toHaveBeenCalledTimes(2);
    expect(override).toMatchObject({
      kind: "ReturnedOrigin",
      section: { section_id: first.section_id },
    });
    expect(readerState.viewport.scrollLeft).toBe(27);
    expect(highlightOwner.clear).toHaveBeenCalled();
    expect(focusReaderViewport).toHaveBeenCalledTimes(1);
  });

  it("retires the unsafe Find state when exact Return restoration defects", async () => {
    const first = sectionContent({
      sectionId: "section-1",
      label: "Opening",
      ordinal: 0,
      fragmentId: FIRST_FRAGMENT,
      canonicalText: "Opening text",
    });
    const second = sectionContent({
      sectionId: "section-2",
      label: "Later",
      ordinal: 1,
      fragmentId: SECOND_FRAGMENT,
      canonicalText: "Later needle",
    });
    const snapshot = findSnapshot([first, second]);
    let readerState = readerViewState(first);
    let override: EpubRenderedSectionOverride | null = null;
    let breakReturnedOrigin = false;
    const setRenderedSectionOverride = vi.fn(
      (next: EpubRenderedSectionOverride | null) => {
        override = next;
        if (!next) return;
        const nextState = readerViewState(next.section);
        readerState =
          breakReturnedOrigin && next.kind === "ReturnedOrigin"
            ? {
                ...nextState,
                section: {
                  ...nextState.section,
                  char_count: nextState.section.char_count + 1,
                },
              }
            : nextState;
      },
    );
    const previewLease = createMediaFindPreviewLease();
    const retire = vi.spyOn(previewLease, "retire");
    const setAwaitingReaderAdoption = vi.fn();
    const resetRenderedSectionAuxiliaryState = vi.fn();
    const adapter = createEpubFindAdapter({
      snapshot,
      getCurrentSourceKey: () => snapshot.sourceKey,
      getRenderedState: () => readerState,
      getRenderedSectionOverride: () => override,
      setRenderedSectionOverride,
      previewLease,
      setAwaitingReaderAdoption,
      resetRenderedSectionAuxiliaryState,
      onSourceChanged: vi.fn(),
      focusReaderViewport: vi.fn(),
      highlightOwner: { publish: vi.fn(), clear: vi.fn() },
      scrollPositioner,
      findOccurrences: vi.fn(async () =>
        ready(snapshot.sourceWitnessFragmentId, [
          occurrence(second, 6, 12),
        ]),
      ),
      loadSection: vi.fn(async () => second),
    });
    const signal = new AbortController().signal;
    await adapter.prepare({
      sessionId: 1,
      sourceKey: snapshot.sourceKey,
      signal,
    });
    const response = await adapter.find(findRequest(snapshot.sourceKey));
    if (response.kind !== "Ready") throw new Error("expected Ready");
    await adapter.preview({
      sessionId: 1,
      queryId: 1,
      sourceKey: snapshot.sourceKey,
      signal,
      key: response.rows[0]!.key,
    });

    breakReturnedOrigin = true;
    await expect(
      adapter.returnToReadingPosition({
        sessionId: 1,
        sourceKey: snapshot.sourceKey,
        signal,
      }),
    ).rejects.toThrow("canonical rendered-section mismatch");
    expect(override).toBeNull();
    expect(retire).toHaveBeenCalledTimes(1);
    expect(setAwaitingReaderAdoption).toHaveBeenLastCalledWith(false);
    expect(resetRenderedSectionAuxiliaryState.mock.calls.length).toBeGreaterThan(
      1,
    );
  });

  it("models exhausted transport and restores an earlier cross-section preview before rejecting", async () => {
    const sections = [
      sectionContent({
        sectionId: "section-1",
        label: "Opening",
        ordinal: 0,
        fragmentId: FIRST_FRAGMENT,
        canonicalText: "Opening text",
      }),
      sectionContent({
        sectionId: "section-2",
        label: "Middle",
        ordinal: 1,
        fragmentId: SECOND_FRAGMENT,
        canonicalText: "Middle needle",
      }),
      sectionContent({
        sectionId: "section-3",
        label: "Ending",
        ordinal: 2,
        fragmentId: THIRD_FRAGMENT,
        canonicalText: "Ending needle",
      }),
    ] as const;
    const snapshot = findSnapshot(sections);
    let readerState = readerViewState(sections[0], 19);
    let override: EpubRenderedSectionOverride | null = null;
    const setRenderedSectionOverride = vi.fn(
      (next: EpubRenderedSectionOverride | null) => {
        override = next;
        if (next) readerState = readerViewState(next.section);
      },
    );
    const transport = new ApiError(
      503,
      "E_UPSTREAM",
      "Upstream connection exhausted.",
    );
    const loadSection = vi.fn(async ({ sectionId }: { sectionId: string }) => {
      if (sectionId === sections[1].section_id) return sections[1];
      throw transport;
    });
    const highlightOwner = { publish: vi.fn(), clear: vi.fn() };
    const adapter = createEpubFindAdapter({
      snapshot,
      getCurrentSourceKey: () => snapshot.sourceKey,
      getRenderedState: () => readerState,
      getRenderedSectionOverride: () => override,
      setRenderedSectionOverride,
      previewLease: createMediaFindPreviewLease(),
      setAwaitingReaderAdoption: vi.fn(),
      resetRenderedSectionAuxiliaryState: vi.fn(),
      onSourceChanged: vi.fn(),
      focusReaderViewport: vi.fn(),
      highlightOwner,
      scrollPositioner,
      findOccurrences: vi.fn(async () =>
        ready(snapshot.sourceWitnessFragmentId, [
          occurrence(sections[1], 7, 13),
          occurrence(sections[2], 7, 13),
        ]),
      ),
      loadSection,
    });
    const signal = new AbortController().signal;
    await adapter.prepare({
      sessionId: 1,
      sourceKey: snapshot.sourceKey,
      signal,
    });
    const response = await adapter.find(findRequest(snapshot.sourceKey));
    if (response.kind !== "Ready") throw new Error("expected Ready");
    await adapter.preview({
      sessionId: 1,
      queryId: 1,
      sourceKey: snapshot.sourceKey,
      signal,
      key: response.rows[0]!.key,
    });

    await expect(
      adapter.preview({
        sessionId: 1,
        queryId: 1,
        sourceKey: snapshot.sourceKey,
        signal,
        key: response.rows[1]!.key,
      }),
    ).resolves.toMatchObject({
      kind: "Rejected",
      error: { kind: "RequestUnavailable" },
    });
    expect(override).toMatchObject({
      kind: "ReturnedOrigin",
      section: { section_id: sections[0].section_id },
    });
    expect(readerState.section.section_id).toBe(sections[0].section_id);
    expect(readerState.viewport.scrollLeft).toBe(19);
    expect(highlightOwner.clear).toHaveBeenCalled();

    const queryTransportAdapter = createEpubFindAdapter({
      snapshot,
      getCurrentSourceKey: () => snapshot.sourceKey,
      getRenderedState: () => readerState,
      getRenderedSectionOverride: () => override,
      setRenderedSectionOverride,
      previewLease: createMediaFindPreviewLease(),
      setAwaitingReaderAdoption: vi.fn(),
      resetRenderedSectionAuxiliaryState: vi.fn(),
      onSourceChanged: vi.fn(),
      focusReaderViewport: vi.fn(),
      highlightOwner: { publish: vi.fn(), clear: vi.fn() },
      scrollPositioner,
      findOccurrences: vi.fn(async () => {
        throw transport;
      }),
    });
    await queryTransportAdapter.prepare({
      sessionId: 1,
      sourceKey: snapshot.sourceKey,
      signal,
    });
    await expect(
      queryTransportAdapter.find(findRequest(snapshot.sourceKey)),
    ).resolves.toMatchObject({
      kind: "Failed",
      error: { kind: "RequestUnavailable" },
    });
  });

  it("retires unsafe Find state when a failed preview cannot restore its origin", async () => {
    const sections = [
      sectionContent({
        sectionId: "section-1",
        label: "Opening",
        ordinal: 0,
        fragmentId: FIRST_FRAGMENT,
        canonicalText: "Opening text",
      }),
      sectionContent({
        sectionId: "section-2",
        label: "Middle",
        ordinal: 1,
        fragmentId: SECOND_FRAGMENT,
        canonicalText: "Middle needle",
      }),
      sectionContent({
        sectionId: "section-3",
        label: "Ending",
        ordinal: 2,
        fragmentId: THIRD_FRAGMENT,
        canonicalText: "Ending needle",
      }),
    ] as const;
    const snapshot = findSnapshot(sections);
    let readerState = readerViewState(sections[0]);
    let override: EpubRenderedSectionOverride | null = null;
    let breakReturnedOrigin = false;
    const setRenderedSectionOverride = vi.fn(
      (next: EpubRenderedSectionOverride | null) => {
        override = next;
        if (!next) return;
        const nextState = readerViewState(next.section);
        readerState =
          breakReturnedOrigin && next.kind === "ReturnedOrigin"
            ? {
                ...nextState,
                section: {
                  ...nextState.section,
                  char_count: nextState.section.char_count + 1,
                },
              }
            : nextState;
      },
    );
    const transport = new ApiError(
      503,
      "E_UPSTREAM",
      "Upstream connection exhausted.",
    );
    const previewLease = createMediaFindPreviewLease();
    const retire = vi.spyOn(previewLease, "retire");
    const setAwaitingReaderAdoption = vi.fn();
    const resetRenderedSectionAuxiliaryState = vi.fn();
    const highlightOwner = { publish: vi.fn(), clear: vi.fn() };
    const adapter = createEpubFindAdapter({
      snapshot,
      getCurrentSourceKey: () => snapshot.sourceKey,
      getRenderedState: () => readerState,
      getRenderedSectionOverride: () => override,
      setRenderedSectionOverride,
      previewLease,
      setAwaitingReaderAdoption,
      resetRenderedSectionAuxiliaryState,
      onSourceChanged: vi.fn(),
      focusReaderViewport: vi.fn(),
      highlightOwner,
      scrollPositioner,
      findOccurrences: vi.fn(async () =>
        ready(snapshot.sourceWitnessFragmentId, [
          occurrence(sections[1], 7, 13),
          occurrence(sections[2], 7, 13),
        ]),
      ),
      loadSection: vi.fn(async ({ sectionId }) => {
        if (sectionId === sections[1].section_id) return sections[1];
        throw transport;
      }),
    });
    const signal = new AbortController().signal;
    await adapter.prepare({
      sessionId: 1,
      sourceKey: snapshot.sourceKey,
      signal,
    });
    const response = await adapter.find(findRequest(snapshot.sourceKey));
    if (response.kind !== "Ready") throw new Error("expected Ready");
    await adapter.preview({
      sessionId: 1,
      queryId: 1,
      sourceKey: snapshot.sourceKey,
      signal,
      key: response.rows[0]!.key,
    });

    breakReturnedOrigin = true;
    await expect(
      adapter.preview({
        sessionId: 1,
        queryId: 1,
        sourceKey: snapshot.sourceKey,
        signal,
        key: response.rows[1]!.key,
      }),
    ).rejects.toThrow("canonical rendered-section mismatch");
    expect(override).toBeNull();
    expect(retire).toHaveBeenCalledTimes(1);
    expect(setAwaitingReaderAdoption).toHaveBeenLastCalledWith(false);
    expect(highlightOwner.clear).toHaveBeenCalled();
    expect(resetRenderedSectionAuxiliaryState.mock.calls.length).toBeGreaterThan(
      1,
    );
    await expect(
      adapter.returnToReadingPosition({
        sessionId: 1,
        sourceKey: snapshot.sourceKey,
        signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("does not let a superseded preview restore over its successor", async () => {
    const sections = [
      sectionContent({
        sectionId: "section-1",
        label: "Opening",
        ordinal: 0,
        fragmentId: FIRST_FRAGMENT,
        canonicalText: "Opening text",
      }),
      sectionContent({
        sectionId: "section-2",
        label: "Middle",
        ordinal: 1,
        fragmentId: SECOND_FRAGMENT,
        canonicalText: "Middle needle",
      }),
      sectionContent({
        sectionId: "section-3",
        label: "Ending",
        ordinal: 2,
        fragmentId: THIRD_FRAGMENT,
        canonicalText: "Ending needle",
      }),
    ] as const;
    const snapshot = findSnapshot(sections);
    let readerState = readerViewState(sections[0]);
    let override: EpubRenderedSectionOverride | null = null;
    const setRenderedSectionOverride = vi.fn(
      (next: EpubRenderedSectionOverride | null) => {
        override = next;
        if (
          next?.kind === "ReturnedOrigin" ||
          next?.section.section_id === sections[2].section_id
        ) {
          readerState = readerViewState(next.section);
        }
      },
    );
    const animationFrames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(
      (callback) => {
        animationFrames.push(callback);
        return animationFrames.length;
      },
    );
    let settleSuccessor!: (section: EpubSectionContent) => void;
    const successorSection = new Promise<EpubSectionContent>((resolve) => {
      settleSuccessor = resolve;
    });
    const loadSection = vi.fn(({ sectionId }: { sectionId: string }) =>
      sectionId === sections[1].section_id
        ? Promise.resolve(sections[1])
        : successorSection,
    );
    const adapter = createEpubFindAdapter({
      snapshot,
      getCurrentSourceKey: () => snapshot.sourceKey,
      getRenderedState: () => readerState,
      getRenderedSectionOverride: () => override,
      setRenderedSectionOverride,
      previewLease: createMediaFindPreviewLease(),
      setAwaitingReaderAdoption: vi.fn(),
      resetRenderedSectionAuxiliaryState: vi.fn(),
      onSourceChanged: vi.fn(),
      focusReaderViewport: vi.fn(),
      highlightOwner: { publish: vi.fn(), clear: vi.fn() },
      scrollPositioner,
      findOccurrences: vi.fn(async () =>
        ready(snapshot.sourceWitnessFragmentId, [
          occurrence(sections[1], 7, 13),
          occurrence(sections[2], 7, 13),
        ]),
      ),
      loadSection,
    });
    const signal = new AbortController().signal;
    await adapter.prepare({
      sessionId: 1,
      sourceKey: snapshot.sourceKey,
      signal,
    });
    const response = await adapter.find(findRequest(snapshot.sourceKey));
    if (response.kind !== "Ready") throw new Error("expected Ready");

    const staleAbort = new AbortController();
    const stalePreview = adapter.preview({
      sessionId: 1,
      queryId: 1,
      sourceKey: snapshot.sourceKey,
      signal: staleAbort.signal,
      key: response.rows[0]!.key,
    });
    await vi.waitFor(() => {
      expect(override).toMatchObject({
        kind: "FindPreview",
        section: { section_id: sections[1].section_id },
      });
    });

    staleAbort.abort();
    const successor = adapter.preview({
      sessionId: 1,
      queryId: 1,
      sourceKey: snapshot.sourceKey,
      signal,
      key: response.rows[1]!.key,
    });
    await waitFor(() => expect(loadSection).toHaveBeenCalledTimes(2));
    readerState = readerViewState(sections[1]);
    settleSuccessor(sections[2]);
    await expect(successor).resolves.toMatchObject({
      kind: "Previewed",
      key: response.rows[1]!.key,
    });
    for (const callback of animationFrames.splice(0)) {
      callback(performance.now());
    }
    await expect(stalePreview).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(override).toMatchObject({
      kind: "FindPreview",
      section: { section_id: sections[2].section_id },
    });
    expect(
      setRenderedSectionOverride.mock.calls.some(
        ([value]) => value?.kind === "ReturnedOrigin",
      ),
    ).toBe(false);
  });

  it("does not restore or reject after ordinary navigation supersedes a pending preview", async () => {
    const first = sectionContent({
      sectionId: "section-1",
      label: "Opening",
      ordinal: 0,
      fragmentId: FIRST_FRAGMENT,
      canonicalText: "Opening text",
    });
    const second = sectionContent({
      sectionId: "section-2",
      label: "Later",
      ordinal: 1,
      fragmentId: SECOND_FRAGMENT,
      canonicalText: "Later needle",
    });
    const snapshot = findSnapshot([first, second]);
    let rejectSection!: (reason: unknown) => void;
    const sectionRequest = new Promise<EpubSectionContent>(
      (_resolve, reject) => {
        rejectSection = reject;
      },
    );
    let readerState = readerViewState(first);
    const previewLease = createMediaFindPreviewLease();
    const setRenderedSectionOverride = vi.fn();
    const onSourceChanged = vi.fn();
    const loadSection = vi.fn(() => sectionRequest);
    const adapter = createEpubFindAdapter({
      snapshot,
      getCurrentSourceKey: () => snapshot.sourceKey,
      getRenderedState: () => readerState,
      getRenderedSectionOverride: () => null,
      setRenderedSectionOverride,
      previewLease,
      setAwaitingReaderAdoption: vi.fn(),
      resetRenderedSectionAuxiliaryState: vi.fn(),
      onSourceChanged,
      focusReaderViewport: vi.fn(),
      highlightOwner: { publish: vi.fn(), clear: vi.fn() },
      scrollPositioner,
      findOccurrences: vi.fn(async () =>
        ready(snapshot.sourceWitnessFragmentId, [
          occurrence(second, 6, 12),
        ]),
      ),
      loadSection,
    });
    const signal = new AbortController().signal;
    await adapter.prepare({
      sessionId: 1,
      sourceKey: snapshot.sourceKey,
      signal,
    });
    const response = await adapter.find(findRequest(snapshot.sourceKey));
    if (response.kind !== "Ready") throw new Error("expected Ready");
    const preview = adapter.preview({
      sessionId: 1,
      queryId: 1,
      sourceKey: snapshot.sourceKey,
      signal,
      key: response.rows[0]!.key,
    });
    await waitFor(() => expect(loadSection).toHaveBeenCalledTimes(1));

    previewLease.releaseForGenuineInput();
    readerState = readerViewState(second);
    rejectSection(
      new ApiError(503, "E_UPSTREAM", "Upstream connection exhausted."),
    );

    await expect(preview).rejects.toMatchObject({ name: "AbortError" });
    expect(setRenderedSectionOverride).not.toHaveBeenCalled();
    expect(onSourceChanged).not.toHaveBeenCalled();
  });

  it("cancels a loaded-section identity mismatch as source replacement and leaves same-system defects unmodeled", async () => {
    const first = sectionContent({
      sectionId: "section-1",
      label: "Opening",
      ordinal: 0,
      fragmentId: FIRST_FRAGMENT,
      canonicalText: "Opening text",
    });
    const second = sectionContent({
      sectionId: "section-2",
      label: "Later",
      ordinal: 1,
      fragmentId: SECOND_FRAGMENT,
      canonicalText: "Later needle",
    });
    const snapshot = findSnapshot([first, second]);
    const onSourceChanged = vi.fn();
    const setRenderedSectionOverride = vi.fn();
    const findOccurrences = vi.fn(async () =>
      ready(snapshot.sourceWitnessFragmentId, [
        occurrence(second, 6, 12),
      ]),
    );
    const adapter = createEpubFindAdapter({
      snapshot,
      getCurrentSourceKey: () => snapshot.sourceKey,
      getRenderedState: () => readerViewState(first),
      getRenderedSectionOverride: () => null,
      setRenderedSectionOverride,
      previewLease: createMediaFindPreviewLease(),
      setAwaitingReaderAdoption: vi.fn(),
      resetRenderedSectionAuxiliaryState: vi.fn(),
      onSourceChanged,
      focusReaderViewport: vi.fn(),
      highlightOwner: { publish: vi.fn(), clear: vi.fn() },
      scrollPositioner,
      findOccurrences,
      loadSection: vi.fn(async () => ({
        ...second,
        fragment_id: THIRD_FRAGMENT,
      })),
    });
    const signal = new AbortController().signal;
    await adapter.prepare({
      sessionId: 1,
      sourceKey: snapshot.sourceKey,
      signal,
    });
    const response = await adapter.find(findRequest(snapshot.sourceKey));
    if (response.kind !== "Ready") throw new Error("expected Ready");
    await expect(
      adapter.preview({
        sessionId: 1,
        queryId: 1,
        sourceKey: snapshot.sourceKey,
        signal,
        key: response.rows[0]!.key,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(onSourceChanged).toHaveBeenCalledTimes(1);
    expect(setRenderedSectionOverride).toHaveBeenCalledWith(null);

    const defect = new ApiError(500, "E_INTERNAL", "Server defect.");
    let nextFailure: unknown = defect;
    const routeBoundarySourceChange = vi.fn();
    const defectAdapter = createEpubFindAdapter({
      snapshot,
      getCurrentSourceKey: () => snapshot.sourceKey,
      getRenderedState: () => readerViewState(first),
      getRenderedSectionOverride: () => null,
      setRenderedSectionOverride,
      previewLease: createMediaFindPreviewLease(),
      setAwaitingReaderAdoption: vi.fn(),
      resetRenderedSectionAuxiliaryState: vi.fn(),
      onSourceChanged: routeBoundarySourceChange,
      focusReaderViewport: vi.fn(),
      highlightOwner: { publish: vi.fn(), clear: vi.fn() },
      scrollPositioner,
      findOccurrences: vi.fn(async () => {
        throw nextFailure;
      }),
    });
    await defectAdapter.prepare({
      sessionId: 1,
      sourceKey: snapshot.sourceKey,
      signal,
    });
    await expect(
      defectAdapter.find(findRequest(snapshot.sourceKey)),
    ).rejects.toBe(defect);
    const mediaNotReady = new ApiError(
      409,
      "E_MEDIA_NOT_READY",
      "Media is no longer ready.",
    );
    nextFailure = mediaNotReady;
    await expect(
      defectAdapter.find(findRequest(snapshot.sourceKey, 2)),
    ).rejects.toBe(mediaNotReady);
    expect(routeBoundarySourceChange).not.toHaveBeenCalled();
  });
});

describe("EPUB Find foundation composition", () => {
  it("retries an exhausted query with the exact query contract", async () => {
    const first = sectionContent({
      sectionId: "section-1",
      label: "Opening",
      ordinal: 0,
      fragmentId: FIRST_FRAGMENT,
      canonicalText: "Opening needle",
    });
    const snapshot = findSnapshot([first]);
    const transport = new ApiError(
      503,
      "E_UPSTREAM_TIMEOUT",
      "Upstream request exhausted.",
    );
    let attempts = 0;
    const requests: EpubFindRequest[] = [];
    const findOccurrences = vi.fn(async (input: EpubFindInvocation) => {
      requests.push(input.request);
      attempts += 1;
      if (attempts === 1) throw transport;
      return ready(snapshot.sourceWitnessFragmentId, [
        occurrence(first, 8, 14),
      ]);
    });
    const adapter = createEpubFindAdapter({
      snapshot,
      getCurrentSourceKey: () => snapshot.sourceKey,
      getRenderedState: () => readerViewState(first),
      getRenderedSectionOverride: () => null,
      setRenderedSectionOverride: vi.fn(),
      previewLease: createMediaFindPreviewLease(),
      setAwaitingReaderAdoption: vi.fn(),
      resetRenderedSectionAuxiliaryState: vi.fn(),
      onSourceChanged: vi.fn(),
      focusReaderViewport: vi.fn(),
      highlightOwner: { publish: vi.fn(), clear: vi.fn() },
      scrollPositioner,
      findOccurrences,
    });
    const view = renderHook(() => {
      const result = usePaneFind({
        capability: { kind: "Available", adapter },
      });
      if (result.kind !== "Available") {
        throw new Error("Expected EPUB Find capability.");
      }
      return result.controller;
    });
    await waitFor(() => expect(view.result.current.result.kind).toBe("Idle"));

    act(() => view.result.current.onQueryChange("needle"));
    await waitFor(() =>
      expect(view.result.current.result.kind).toBe("Failed"),
    );
    const failed = view.result.current.result;
    if (failed.kind !== "Failed") throw new Error("expected Failed");
    act(() => failed.onRetry());
    await waitFor(() =>
      expect(view.result.current.result.kind).toBe("Ready"),
    );

    expect(findOccurrences).toHaveBeenCalledTimes(2);
    expect(requests[1]).toEqual(requests[0]);
    adapter.dispose();
  });

  it("retries an exhausted preview for the exact result key without rerunning the query", async () => {
    const first = sectionContent({
      sectionId: "section-1",
      label: "Opening",
      ordinal: 0,
      fragmentId: FIRST_FRAGMENT,
      canonicalText: "Opening needle",
    });
    const second = sectionContent({
      sectionId: "section-2",
      label: "Later",
      ordinal: 1,
      fragmentId: SECOND_FRAGMENT,
      canonicalText: "Later needle",
    });
    const snapshot = findSnapshot([first, second]);
    let readerState = readerViewState(first);
    let override: EpubRenderedSectionOverride | null = null;
    const findOccurrences = vi.fn(async () =>
      ready(snapshot.sourceWitnessFragmentId, [
        occurrence(first, 8, 14),
        occurrence(second, 6, 12),
      ]),
    );
    let attempts = 0;
    const loadSection = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new ApiError(
          503,
          "E_UPSTREAM",
          "Upstream connection exhausted.",
        );
      }
      return second;
    });
    const adapter = createEpubFindAdapter({
      snapshot,
      getCurrentSourceKey: () => snapshot.sourceKey,
      getRenderedState: () => readerState,
      getRenderedSectionOverride: () => override,
      setRenderedSectionOverride: (next) => {
        override = next;
        if (next) readerState = readerViewState(next.section);
      },
      previewLease: createMediaFindPreviewLease(),
      setAwaitingReaderAdoption: vi.fn(),
      resetRenderedSectionAuxiliaryState: vi.fn(),
      onSourceChanged: vi.fn(),
      focusReaderViewport: vi.fn(),
      highlightOwner: { publish: vi.fn(), clear: vi.fn() },
      scrollPositioner,
      findOccurrences,
      loadSection,
    });
    const preview = vi.spyOn(adapter, "preview");
    const view = renderHook(() => {
      const result = usePaneFind({
        capability: { kind: "Available", adapter },
      });
      if (result.kind !== "Available") {
        throw new Error("Expected EPUB Find capability.");
      }
      return result.controller;
    });
    await waitFor(() => expect(view.result.current.result.kind).toBe("Idle"));

    act(() => view.result.current.onQueryChange("needle"));
    await waitFor(() => {
      expect(view.result.current.result.kind).toBe("Ready");
      expect(view.result.current.returnToReadingPosition.kind).toBe(
        "Available",
      );
    });
    const readyResult = view.result.current.result;
    if (readyResult.kind !== "Ready") throw new Error("expected Ready");
    const targetKey = readyResult.rows[1]!.key;
    act(() => {
      void view.result.current.onActivate(targetKey);
    });
    await waitFor(() =>
      expect(view.result.current.result.kind).toBe("Failed"),
    );
    const failed = view.result.current.result;
    if (failed.kind !== "Failed") throw new Error("expected Failed");
    act(() => failed.onRetry());
    await waitFor(() =>
      expect(view.result.current.result.kind).toBe("Ready"),
    );

    expect(findOccurrences).toHaveBeenCalledTimes(1);
    expect(loadSection).toHaveBeenCalledTimes(2);
    expect(preview).toHaveBeenCalledTimes(3);
    expect(preview.mock.calls[2]![0].key).toBe(
      preview.mock.calls[1]![0].key,
    );
    expect(preview.mock.calls[2]![0].key).toBe(targetKey);
    expect(override).toMatchObject({
      kind: "FindPreview",
      section: { section_id: second.section_id },
    });
    adapter.dispose();
  });
});

describe("useEpubPaneFind", () => {
  it("publishes an explicit unavailable or EPUB adapter capability", () => {
    const first = sectionContent({
      sectionId: "section-1",
      label: "Opening",
      ordinal: 0,
      fragmentId: FIRST_FRAGMENT,
      canonicalText: "Opening text",
    });
    const navigation = [
      navigationSection({
        sectionId: first.section_id,
        label: first.label,
        ordinal: first.ordinal,
        fragmentId: first.fragment_id,
        canonicalText: first.canonical_text,
      }),
    ];
    const readerStateRef = { current: readerViewState(first) };
    const previewLease = {
      isActive: vi.fn(() => false),
      beginSource: vi.fn(),
      acquire: vi.fn(),
      cancelUnreportedPreview: vi.fn(),
      retire: vi.fn(),
    };
    const getRenderedSectionOverride = vi.fn(() => null);
    const setRenderedSectionOverride = vi.fn();
    const setAwaitingReaderAdoption = vi.fn();
    const resetRenderedSectionAuxiliaryState = vi.fn();
    const onSourceChanged = vi.fn();
    const focusReaderViewport = vi.fn();
    const { result, rerender, unmount } = renderHook(
      ({ currentNavigation }) =>
        useEpubPaneFind({
          mediaId: MEDIA_ID,
          fragments: currentNavigation
            ? [
                {
                  fragment_id: first.fragment_id,
                  fragment_idx: first.fragment_idx,
                  char_count: first.char_count,
                },
              ]
            : null,
          navigation: currentNavigation,
          renderedStateRef: readerStateRef,
          getRenderedSectionOverride,
          setRenderedSectionOverride,
          previewLease,
          setAwaitingReaderAdoption,
          resetRenderedSectionAuxiliaryState,
          onSourceChanged,
          focusReaderViewport,
          scrollPositioner,
        }),
      {
        initialProps: {
          currentNavigation: null as readonly ReaderNavigationSection[] | null,
        },
      },
    );
    expect(result.current).toEqual({ kind: "Unavailable" });

    rerender({ currentNavigation: navigation });
    expect(result.current.kind).toBe("Available");
    expect(previewLease.beginSource).toHaveBeenCalledTimes(1);
    unmount();
    expect(previewLease.retire).toHaveBeenCalledTimes(1);
  });
});
