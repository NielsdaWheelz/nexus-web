import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useState } from "react";
import { buildCanonicalCursor } from "@/lib/highlights/canonicalCursor";
import type { Fragment } from "@/lib/media/transcriptView";
import type { ReaderNavigationSection } from "@/lib/media/readerNavigation";
import type { PaneFindResultKey } from "@/lib/panes/paneSearch";
import { usePaneFind } from "@/lib/panes/usePaneFind";
import {
  createWebFindAdapter,
  createWebFindSnapshot,
  resolvePreparedWebSectionScope,
  type WebFindRenderedState,
  useWebPaneFindCapability,
} from "./useMediaPaneFind";
import { createMediaFindPreviewLease } from "./mediaFindPreviewLease";

function fragment(id: string, idx: number, canonicalText: string): Fragment {
  return {
    id,
    media_id: "media-1",
    idx,
    html_sanitized: `<p>${canonicalText}</p>`,
    canonical_text: canonicalText,
    document_embeds: [],
    created_at: `2026-01-0${idx + 1}T00:00:00Z`,
  };
}

function section(
  overrides: Partial<ReaderNavigationSection>,
): ReaderNavigationSection {
  return {
    section_id: "section-1",
    label: "Section one",
    ordinal: 0,
    fragment_id: "fragment-1",
    fragment_idx: 0,
    level: 1,
    depth: 1,
    start_offset: 0,
    end_offset: 20,
    href_path: null,
    href_fragment: null,
    anchor_id: null,
    char_count: 20,
    ...overrides,
  };
}

function rendered(
  fragmentId: string,
  canonicalText: string,
): WebFindRenderedState {
  const root = document.createElement("div");
  root.innerHTML = `<p>${canonicalText}</p>`;
  // Detached canonical-DOM fixture; no Testing Library query owns this node.
  // eslint-disable-next-line testing-library/no-node-access
  root.querySelector("p")!.getBoundingClientRect = () =>
    ({ top: 50, bottom: 80, left: 10, right: 300 }) as DOMRect;
  const viewport = document.createElement("div");
  Object.defineProperty(viewport, "scrollTop", {
    configurable: true,
    writable: true,
    value: 100,
  });
  Object.defineProperty(viewport, "scrollLeft", {
    configurable: true,
    writable: true,
    value: 12,
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
    fragmentId,
    canonicalText,
    cursor: buildCanonicalCursor(root),
    viewport,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Web Find adapter", () => {
  it("chooses the deepest, narrowest containing section and freezes exact bounds", () => {
    const resolved = resolvePreparedWebSectionScope({
      sections: [
        section({ section_id: "wide", start_offset: 0, end_offset: 100 }),
        section({
          section_id: "deep-wide",
          depth: 2,
          start_offset: 10,
          end_offset: 80,
          ordinal: 3,
        }),
        section({
          section_id: "deep-narrow-later",
          depth: 2,
          start_offset: 20,
          end_offset: 40,
          ordinal: 2,
        }),
        section({
          section_id: "deep-narrow-first",
          depth: 2,
          start_offset: 20,
          end_offset: 40,
          ordinal: 1,
        }),
      ],
      fragmentId: "fragment-1",
      anchorCp: 25,
      fragmentLengthCp: 100,
    });

    expect(resolved).toEqual({
      id: "CurrentSection:deep-narrow-first",
      fragmentId: "fragment-1",
      startCp: 20,
      endCp: 40,
    });
  });

  it("uses right-open section bounds for two adjacent sections in one fragment", () => {
    const sections = [
      section({
        section_id: "first",
        start_offset: 0,
        end_offset: 10,
      }),
      section({
        section_id: "second",
        start_offset: 10,
        end_offset: 20,
      }),
    ];

    expect(
      resolvePreparedWebSectionScope({
        sections,
        fragmentId: "fragment-1",
        anchorCp: 10,
        fragmentLengthCp: 20,
      }),
    ).toMatchObject({ id: "CurrentSection:second", startCp: 10, endCp: 20 });
    expect(
      resolvePreparedWebSectionScope({
        sections: [
          section({
            section_id: "invalid",
            start_offset: 10,
            end_offset: 21,
          }),
        ],
        fragmentId: "fragment-1",
        anchorCp: 10,
        fragmentLengthCp: 20,
      }),
    ).toBeNull();
  });

  it("searches ordered canonical fragments, previews exact ranges, and returns once to the origin", async () => {
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue({
      top: 70,
      bottom: 88,
      left: 10,
      right: 20,
      height: 18,
      width: 10,
    } as DOMRect);
    const snapshot = createWebFindSnapshot({
      mediaId: "media-1",
      fragments: [
        fragment("fragment-2", 1, "Second target"),
        fragment("fragment-1", 0, "First target"),
      ],
      sections: [
        section({
          section_id: "first",
          fragment_id: "fragment-1",
          end_offset: 12,
          label: "Opening",
        }),
        section({
          section_id: "second",
          fragment_id: "fragment-2",
          fragment_idx: 1,
          end_offset: 13,
          label: "Later",
        }),
      ],
    });
    let utils = rendered("fragment-1", "First target");
    const renderedById = new Map([
      ["fragment-1", utils],
      ["fragment-2", rendered("fragment-2", "Second target")],
    ]);
    const showPreviewFragment = vi.fn(async (fragmentId: string) => {
      utils = renderedById.get(fragmentId)!;
      return utils;
    });
    const focusReaderViewport = vi.fn();
    const clearPreviewFragment = vi.fn();
    const previewLease = createMediaFindPreviewLease();
    const highlightOwner = {
      publish: vi.fn(),
      clear: vi.fn(),
    };
    const adapter = createWebFindAdapter({
      snapshot,
      getCurrentSourceKey: () => snapshot.sourceKey,
      getRenderedState: () => utils,
      showPreviewFragment,
      clearPreviewFragment,
      focusReaderViewport,
      previewLease,
      highlightOwner,
    });
    const abort = new AbortController();
    await adapter.prepare({
      sessionId: 1,
      sourceKey: snapshot.sourceKey,
      signal: abort.signal,
    });
    const response = await adapter.find({
      sessionId: 1,
      queryId: 1,
      sourceKey: snapshot.sourceKey,
      signal: abort.signal,
      query: "target",
      scopeId: "EntireArticle",
      matchCase: false,
      wholeWord: true,
    });
    expect(response.kind).toBe("Ready");
    if (response.kind !== "Ready") throw new Error("expected ready response");
    expect(response.initialActiveKey).toBe(response.rows[0]?.key);
    expect(response.rows.map((row) => row.context)).toEqual([
      ["Opening"],
      ["Later"],
    ]);
    expect(response.rows.map((row) => JSON.parse(row.key))).toMatchObject([
      {
        source: {
          kind: "WebArticleFragment",
          mediaId: "media-1",
          fragmentId: "fragment-1",
        },
        locator: {
          kind: "FragmentRange",
          fragmentId: "fragment-1",
          startCp: 6,
          endCp: 12,
        },
      },
      {
        source: {
          kind: "WebArticleFragment",
          mediaId: "media-1",
          fragmentId: "fragment-2",
        },
        locator: {
          kind: "FragmentRange",
          fragmentId: "fragment-2",
          startCp: 7,
          endCp: 13,
        },
      },
    ]);

    const secondKey = response.rows[1]!.key;
    await expect(
      adapter.preview({
        sessionId: 1,
        queryId: 1,
        sourceKey: snapshot.sourceKey,
        signal: abort.signal,
        key: secondKey,
      }),
    ).resolves.toMatchObject({ kind: "Previewed", key: secondKey });
    expect(previewLease.isActive()).toBe(true);
    expect(showPreviewFragment).toHaveBeenLastCalledWith(
      "fragment-2",
      abort.signal,
    );
    expect(highlightOwner.publish).toHaveBeenCalledWith({
      all: expect.arrayContaining([expect.any(Range)]),
      active: expect.arrayContaining([expect.any(Range)]),
    });
    const publishCount = highlightOwner.publish.mock.calls.length;
    utils = rendered("fragment-2", "Second target");
    adapter.rebuildPresentation();
    expect(highlightOwner.publish).toHaveBeenCalledTimes(publishCount + 1);

    await adapter.returnToReadingPosition({
      sessionId: 1,
      sourceKey: snapshot.sourceKey,
      signal: abort.signal,
    });
    expect(showPreviewFragment).toHaveBeenLastCalledWith(
      "fragment-1",
      abort.signal,
    );
    expect(utils.viewport.scrollLeft).toBe(12);
    expect(focusReaderViewport).toHaveBeenCalledTimes(1);
    expect(clearPreviewFragment).toHaveBeenCalledTimes(1);
    expect(highlightOwner.clear).toHaveBeenCalled();
  });

  it("rejects an unavailable origin without moving and defects on canonical mismatch before scrolling", async () => {
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue({
      top: 70,
      bottom: 88,
      left: 10,
      right: 20,
      height: 18,
      width: 10,
    } as DOMRect);
    const snapshot = createWebFindSnapshot({
      mediaId: "media-1",
      fragments: [
        fragment("fragment-1", 0, "First target"),
        fragment("fragment-2", 1, "Second target"),
      ],
      sections: [],
    });
    const highlightOwner = { publish: vi.fn(), clear: vi.fn() };
    const lease = createMediaFindPreviewLease();
    const show = vi.fn();
    const adapter = createWebFindAdapter({
      snapshot,
      getCurrentSourceKey: () => snapshot.sourceKey,
      getRenderedState: () => null,
      showPreviewFragment: show,
      clearPreviewFragment: vi.fn(),
      focusReaderViewport: vi.fn(),
      previewLease: lease,
      highlightOwner,
    });
    const signal = new AbortController().signal;
    await adapter.prepare({
      sessionId: 1,
      sourceKey: snapshot.sourceKey,
      signal,
    });
    const response = await adapter.find({
      sessionId: 1,
      queryId: 1,
      sourceKey: snapshot.sourceKey,
      signal,
      query: "target",
      scopeId: "EntireArticle",
      matchCase: false,
      wholeWord: false,
    });
    if (response.kind !== "Ready") throw new Error("expected ready response");
    const key = response.rows[0]!.key;
    await expect(
      adapter.preview({
        sessionId: 1,
        queryId: 1,
        sourceKey: snapshot.sourceKey,
        signal,
        key,
      }),
    ).resolves.toMatchObject({
      kind: "Rejected",
      error: { kind: "OriginUnavailable" },
    });
    expect(show).not.toHaveBeenCalled();
    expect(lease.isActive()).toBe(false);

    let utils: WebFindRenderedState | null = rendered(
      "fragment-1",
      "First target",
    );
    const mismatchRoot = document.createElement("div");
    mismatchRoot.innerHTML = "<p>Wrong text</p>";
    const mismatched: WebFindRenderedState = {
      ...rendered("fragment-2", "Second target"),
      cursor: buildCanonicalCursor(mismatchRoot),
    };
    const mismatchShow = vi.fn(async (fragmentId: string) => {
      if (fragmentId === "fragment-2") return mismatched;
      utils = rendered("fragment-1", "First target");
      return utils;
    });
    const clearMismatchPreview = vi.fn();
    const mismatchAdapter = createWebFindAdapter({
      snapshot,
      getCurrentSourceKey: () => snapshot.sourceKey,
      getRenderedState: () => utils,
      showPreviewFragment: mismatchShow,
      clearPreviewFragment: clearMismatchPreview,
      focusReaderViewport: vi.fn(),
      previewLease: createMediaFindPreviewLease(),
      highlightOwner,
    });
    await mismatchAdapter.prepare({
      sessionId: 2,
      sourceKey: snapshot.sourceKey,
      signal,
    });
    const mismatchResponse = await mismatchAdapter.find({
      sessionId: 2,
      queryId: 1,
      sourceKey: snapshot.sourceKey,
      signal,
      query: "target",
      scopeId: "EntireArticle",
      matchCase: false,
      wholeWord: false,
    });
    if (mismatchResponse.kind !== "Ready") {
      throw new Error("expected ready response");
    }
    const scrollTop = utils.viewport.scrollTop;
    await expect(
      mismatchAdapter.preview({
        sessionId: 2,
        queryId: 1,
        sourceKey: snapshot.sourceKey,
        signal,
        key: mismatchResponse.rows[1]!.key as PaneFindResultKey,
      }),
    ).rejects.toThrow("canonical DOM mismatch");
    expect(utils.viewport.scrollTop).toBe(scrollTop);
    expect(highlightOwner.publish).not.toHaveBeenCalled();
    expect(mismatchShow.mock.calls.map(([fragmentId]) => fragmentId)).toEqual([
      "fragment-2",
      "fragment-1",
    ]);
    expect(clearMismatchPreview).toHaveBeenCalledTimes(1);
  });

  it("keeps late work from a disposed source from clearing its successor's highlights", async () => {
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue({
      top: 70,
      bottom: 88,
      left: 10,
      right: 20,
      height: 18,
      width: 10,
    } as DOMRect);
    const snapshot = createWebFindSnapshot({
      mediaId: "media-1",
      fragments: [
        fragment("fragment-1", 0, "Origin text"),
        fragment("fragment-2", 1, "Find needle"),
      ],
      sections: [],
    });
    const highlightOwner = { publish: vi.fn(), clear: vi.fn() };
    let settleTarget!: (value: WebFindRenderedState) => void;
    const target = new Promise<WebFindRenderedState>((resolve) => {
      settleTarget = resolve;
    });
    const adapter = createWebFindAdapter({
      snapshot,
      getCurrentSourceKey: () => snapshot.sourceKey,
      getRenderedState: () => rendered("fragment-1", "Origin text"),
      showPreviewFragment: () => target,
      clearPreviewFragment: vi.fn(),
      focusReaderViewport: vi.fn(),
      previewLease: createMediaFindPreviewLease(),
      highlightOwner,
    });
    const signal = new AbortController().signal;
    await adapter.prepare({
      sessionId: 1,
      sourceKey: snapshot.sourceKey,
      signal,
    });
    const response = await adapter.find({
      sessionId: 1,
      queryId: 1,
      sourceKey: snapshot.sourceKey,
      signal,
      query: "needle",
      scopeId: "EntireArticle",
      matchCase: true,
      wholeWord: false,
    });
    if (response.kind !== "Ready") throw new Error("expected ready response");

    const preview = adapter.preview({
      sessionId: 1,
      queryId: 1,
      sourceKey: snapshot.sourceKey,
      signal,
      key: response.rows[0]!.key,
    });
    adapter.dispose();
    const clearsAtReplacement = highlightOwner.clear.mock.calls.length;
    settleTarget(rendered("fragment-2", "Find needle"));

    await expect(preview).rejects.toMatchObject({ name: "AbortError" });
    expect(highlightOwner.clear).toHaveBeenCalledTimes(clearsAtReplacement);
  });
});

describe("useWebPaneFindCapability", () => {
  it("publishes Unavailable without constructing a dummy Web source", () => {
    const lease = createMediaFindPreviewLease();
    const beginSource = vi.spyOn(lease, "beginSource");
    const renderedStateRef: { current: WebFindRenderedState | null } = {
      current: null,
    };
    const { result } = renderHook(() => {
      const [previewFragmentId, setPreviewFragmentId] = useState<string | null>(
        null,
      );
      return useWebPaneFindCapability({
        source: { kind: "Unavailable" },
        renderedStateRef,
        previewFragmentId,
        setPreviewFragmentId,
        focusReaderViewport: vi.fn(),
        previewLease: lease,
      });
    });

    expect(result.current).toEqual({ kind: "Unavailable" });
    expect(beginSource).not.toHaveBeenCalled();
  });

  it("cancels a queued first preview on Close, restores the origin, and reprepares on reopen", async () => {
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue({
      top: 70,
      bottom: 88,
      left: 10,
      right: 20,
      height: 18,
      width: 10,
    } as DOMRect);
    const fragments = [
      fragment("fragment-1", 0, "Origin text"),
      fragment("fragment-2", 1, "Find needle"),
    ];
    const renderedById = new Map([
      ["fragment-1", rendered("fragment-1", "Origin text")],
      ["fragment-2", rendered("fragment-2", "Find needle")],
    ]);
    const renderedStateRef: { current: WebFindRenderedState | null } = {
      current: renderedById.get("fragment-1")!,
    };
    const lease = createMediaFindPreviewLease();
    const focusReaderViewport = vi.fn();
    const sections: readonly ReaderNavigationSection[] = [];
    const view = renderHook(() => {
      const [previewFragmentId, setPreviewFragmentId] = useState<string | null>(
        null,
      );
      // Deliberately withhold fragment-2's commit so Close races a queued
      // preview after its state command but before exact render settlement.
      if (previewFragmentId !== "fragment-2") {
        renderedStateRef.current = renderedById.get(
          previewFragmentId ?? "fragment-1",
        )!;
      }
      const capability = useWebPaneFindCapability({
        source: {
          kind: "Available",
          mediaId: "media-1",
          fragments,
          sections,
        },
        renderedStateRef,
        previewFragmentId,
        setPreviewFragmentId,
        focusReaderViewport,
        previewLease: lease,
      });
      const findResult = usePaneFind({ capability });
      if (findResult.kind !== "Available") {
        throw new Error("Expected Web Find capability.");
      }
      const find = findResult.controller;
      return { find, previewFragmentId };
    });
    await waitFor(() =>
      expect(view.result.current.find.result.kind).toBe("Idle"),
    );

    act(() => {
      view.result.current.find.onQueryChange("needle");
    });
    await waitFor(() =>
      expect(view.result.current.previewFragmentId).toBe("fragment-2"),
    );
    act(() => {
      view.result.current.find.onDismiss();
      view.result.current.find.onOpen();
    });

    await waitFor(() => {
      expect(view.result.current.previewFragmentId).toBeNull();
      expect(view.result.current.find.query).toBe("");
      expect(view.result.current.find.returnToReadingPosition.kind).toBe(
        "Unavailable",
      );
    });
    expect(renderedStateRef.current?.fragmentId).toBe("fragment-1");
    expect(lease.isActive()).toBe(false);
  });

  it("clears after Return and keeps replacement fenced until its preview override retires", async () => {
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue({
      top: 70,
      bottom: 88,
      left: 10,
      right: 20,
      height: 18,
      width: 10,
    } as DOMRect);
    const firstSource = [
      fragment("fragment-1", 0, "Origin text"),
      fragment("fragment-2", 1, "Find needle"),
    ];
    const replacementSource = [fragment("fragment-3", 0, "Replacement text")];
    const renderedById = new Map([
      ["fragment-1", rendered("fragment-1", "Origin text")],
      ["fragment-2", rendered("fragment-2", "Find needle")],
      ["fragment-3", rendered("fragment-3", "Replacement text")],
    ]);
    const renderedStateRef: { current: WebFindRenderedState | null } = {
      current: renderedById.get("fragment-1")!,
    };
    const lease = createMediaFindPreviewLease();
    const focusReaderViewport = vi.fn();
    const sections: readonly ReaderNavigationSection[] = [];
    let committedPreviewFragmentId: string | null = null;
    const view = renderHook(
      ({ fragments }: { fragments: readonly Fragment[] }) => {
        const [previewFragmentId, setPreviewFragmentId] = useState<
          string | null
        >(null);
        committedPreviewFragmentId = previewFragmentId;
        const normalFragmentId = fragments[0]?.id ?? "fragment-1";
        renderedStateRef.current =
          renderedById.get(previewFragmentId ?? normalFragmentId) ?? null;
        const capability = useWebPaneFindCapability({
          source: {
            kind: "Available",
            mediaId: "media-1",
            fragments,
            sections,
          },
          renderedStateRef,
          previewFragmentId,
          setPreviewFragmentId,
          focusReaderViewport,
          previewLease: lease,
        });
        const findResult = usePaneFind({ capability });
        if (findResult.kind !== "Available") {
          throw new Error("Expected Web Find capability.");
        }
        const find = findResult.controller;
        return { find, previewFragmentId };
      },
      { initialProps: { fragments: firstSource as readonly Fragment[] } },
    );

    act(() => {
      view.result.current.find.onQueryChange("needle");
    });
    await waitFor(() => {
      expect(view.result.current.previewFragmentId).toBe("fragment-2");
      expect(view.result.current.find.returnToReadingPosition.kind).toBe(
        "Available",
      );
    });
    act(() => {
      const command = view.result.current.find.returnToReadingPosition;
      if (command.kind === "Available") command.onReturn();
    });
    await waitFor(() =>
      expect(view.result.current.previewFragmentId).toBeNull(),
    );
    expect(renderedStateRef.current?.fragmentId).toBe("fragment-1");

    const ready = view.result.current.find.result;
    if (ready.kind !== "Ready") {
      throw new Error("Expected retained Web Find results after Return.");
    }
    act(() => {
      void view.result.current.find.onActivate(ready.rows[0]!.key);
    });
    await waitFor(() => {
      expect(view.result.current.previewFragmentId).toBe("fragment-2");
      expect(lease.isActive()).toBe(true);
    });
    const leaseTransitions: {
      readonly active: boolean;
      readonly previewFragmentId: string | null;
    }[] = [];
    const unsubscribe = lease.subscribe(() => {
      leaseTransitions.push({
        active: lease.isActive(),
        previewFragmentId: committedPreviewFragmentId,
      });
    });

    view.rerender({ fragments: replacementSource });
    await waitFor(() => {
      expect(view.result.current.previewFragmentId).toBeNull();
      expect(renderedStateRef.current?.fragmentId).toBe("fragment-3");
      expect(lease.isActive()).toBe(false);
    });
    expect(leaseTransitions.filter((transition) => !transition.active)).toEqual(
      [{ active: false, previewFragmentId: null }],
    );
    unsubscribe();
    lease.acquire();
    expect(lease.isActive()).toBe(true);
  });
});
