import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Fragment } from "@/lib/media/transcriptView";
import type { PaneFindResultKey } from "@/lib/panes/paneSearch";
import { usePaneFind } from "@/lib/panes/usePaneFind";
import {
  useReaderScrollPositioner,
  type ReaderScrollPositioner,
} from "@/lib/reader/paneScroll";
import { composeRefs } from "@/lib/ui/composeRefs";
import {
  MobileChromeProvider,
  useMobileChromeReaderScrollport,
} from "@/lib/workspace/mobileChrome";
import type { TranscriptFindPresentation } from "./TranscriptContentPanel";
import {
  createTranscriptFindAdapter,
  createTranscriptFindSnapshot,
  type TranscriptFindAdapter,
} from "./transcriptPaneFind";
import { createMediaFindPreviewLease } from "./mediaFindPreviewLease";

// Kernel-only positioner: the abort/rollback cases below isolate adapter state
// after the real-owner browser scenario proves the production capability.
const kernelScrollPositioner: ReaderScrollPositioner = {
  async run(operation) {
    await operation({
      setTop(scrollport, top) {
        scrollport.scrollTop = Math.max(0, top);
      },
      adjustTop(scrollport, delta) {
        scrollport.scrollTop = Math.max(0, scrollport.scrollTop + delta);
      },
      reveal(scrollport, target) {
        const scrollportRect = scrollport.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        if (targetRect.top < scrollportRect.top) {
          scrollport.scrollTop = Math.max(
            0,
            scrollport.scrollTop + targetRect.top - scrollportRect.top,
          );
        } else if (targetRect.bottom > scrollportRect.bottom) {
          scrollport.scrollTop = Math.max(
            0,
            scrollport.scrollTop + targetRect.bottom - scrollportRect.bottom,
          );
        }
      },
    });
  },
};

function fragment(
  id: string,
  idx: number,
  text: string,
  startMs: number,
): Fragment {
  return {
    id,
    media_id: "media-1",
    idx,
    html_sanitized: `<p>${text}</p>`,
    canonical_text: text,
    document_embeds: [],
    t_start_ms: startMs,
    t_end_ms: startMs + 1_000,
    speaker_label: null,
    created_at: `2026-07-${String(idx + 1).padStart(2, "0")}T00:00:00Z`,
  };
}

function snapshot() {
  return createTranscriptFindSnapshot({
    mediaId: "media-1",
    transcriptState: "ready",
    transcriptCoverage: "full",
    fragments: [
      fragment("origin", 0, "opening", 0),
      fragment("match", 1, "needle then needle", 2_000),
    ],
    chapters: [],
  });
}

function segmentList(): HTMLDivElement {
  const list = document.createElement("div");
  list.tabIndex = -1;
  Object.defineProperty(list, "scrollTop", {
    configurable: true,
    writable: true,
    value: 40,
  });
  list.getBoundingClientRect = () =>
    ({
      top: 0,
      bottom: 100,
      left: 0,
      right: 300,
      width: 300,
      height: 100,
    }) as DOMRect;
  document.body.append(list);
  return list;
}

interface TranscriptFindIntegration {
  readonly adapter: TranscriptFindAdapter;
  readonly owner: HTMLDivElement;
  readonly segmentList: HTMLDivElement;
  readonly previewLease: ReturnType<typeof createMediaFindPreviewLease>;
}

function MobileTranscriptFindHarness({
  onReady,
}: {
  readonly onReady: (integration: TranscriptFindIntegration) => void;
}) {
  const frozen = useMemo(snapshot, []);
  const ownerNodeRef = useRef<HTMLDivElement | null>(null);
  const segmentListRef = useRef<HTMLDivElement | null>(null);
  const activeFragmentIdRef = useRef<string | null>("origin");
  const matchElementsRef = useRef(
    new Map<PaneFindResultKey, HTMLSpanElement>(),
  );
  const [activeFragmentId, setActiveFragmentIdState] = useState<string | null>(
    "origin",
  );
  const [presentation, setPresentation] =
    useState<TranscriptFindPresentation>({ kind: "Text" });
  const previewLease = useMemo(createMediaFindPreviewLease, []);
  const scrollPositioner = useReaderScrollPositioner();
  const chromeScrollportRef =
    useMobileChromeReaderScrollport<HTMLDivElement>({
      sourceKey: frozen.sourceKey,
      enabled: true,
    });
  const prepareOwnerRef = useCallback((owner: HTMLDivElement | null) => {
    ownerNodeRef.current = owner;
    if (!owner) return;
    Object.defineProperties(owner, {
      scrollTop: {
        configurable: true,
        writable: true,
        value: 40,
      },
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 100 },
    });
    owner.getBoundingClientRect = () =>
      ({
        top: 0,
        bottom: 100,
        left: 0,
        right: 300,
        width: 300,
        height: 100,
      }) as DOMRect;
  }, []);
  const ownerRef = useMemo(
    () => composeRefs(prepareOwnerRef, chromeScrollportRef),
    [chromeScrollportRef, prepareOwnerRef],
  );
  const setActiveFragmentId = useCallback((fragmentId: string | null) => {
    activeFragmentIdRef.current = fragmentId;
    setActiveFragmentIdState(fragmentId);
  }, []);
  const publishPresentation = useCallback(
    (nextPresentation: TranscriptFindPresentation) => {
      setPresentation(nextPresentation);
    },
    [],
  );
  const adapter = useMemo(
    () =>
      createTranscriptFindAdapter({
        snapshot: frozen,
        getCurrentSourceKey: () => frozen.sourceKey,
        getActiveFragmentId: () => activeFragmentIdRef.current,
        setActiveFragmentId,
        getSegmentList: () => segmentListRef.current,
        getScrollOwner: () => ownerNodeRef.current,
        getMatchElement: (key) => matchElementsRef.current.get(key) ?? null,
        publishPresentation,
        previewLease,
        scrollPositioner,
      }),
    [
      frozen,
      previewLease,
      publishPresentation,
      scrollPositioner,
      setActiveFragmentId,
    ],
  );

  useEffect(() => {
    const owner = ownerNodeRef.current;
    const segmentList = segmentListRef.current;
    if (!owner || !segmentList) return;
    onReady({ adapter, owner, segmentList, previewLease });
    return () => adapter.dispose();
  }, [adapter, onReady, previewLease]);

  const occurrences =
    presentation.kind === "Matches" ? presentation.occurrences : [];
  const activeKey =
    presentation.kind === "Matches" ? presentation.activeKey : null;
  return (
    <div
      ref={ownerRef}
      data-testid="transcript-outer-scroll-owner"
      style={{ height: 100, overflowY: "auto" }}
    >
      <div
        ref={segmentListRef}
        role="region"
        aria-label="Transcript segments"
        tabIndex={-1}
      >
        {occurrences.map((occurrence) => {
          const active = occurrence.key === activeKey;
          return (
            <span
              key={occurrence.key}
              ref={(element) => {
                if (!element) {
                  matchElementsRef.current.delete(occurrence.key);
                  return;
                }
                const top = occurrence.startCp === 0 ? 20 : 140;
                element.getBoundingClientRect = () =>
                  ({
                    top,
                    bottom: top + 10,
                    left: 0,
                    right: 60,
                    width: 60,
                    height: 10,
                  }) as DOMRect;
                matchElementsRef.current.set(occurrence.key, element);
              }}
              role="mark"
              aria-current={active ? "true" : undefined}
              aria-label={active ? "Current match: needle" : undefined}
            >
              needle
            </span>
          );
        })}
      </div>
      <output aria-label="Active transcript fragment">
        {activeFragmentId ?? "none"}
      </output>
    </div>
  );
}

let mobileViewportActive = false;

async function useMobileTestViewport(): Promise<void> {
  await page.viewport(414, 800);
  mobileViewportActive = true;
}

afterEach(async () => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  if (!mobileViewportActive) return;
  await page.viewport(1_280, 720);
  mobileViewportActive = false;
});

describe("Transcript Find mobile outer-owner integration", () => {
  it("previews through the real mobile outer scroll owner and Returns to its captured origin", async () => {
    await useMobileTestViewport();
    const onReady = vi.fn<
      (integration: TranscriptFindIntegration) => void
    >();
    render(
      <MobileChromeProvider>
        <MobileTranscriptFindHarness onReady={onReady} />
      </MobileChromeProvider>,
    );
    await waitFor(() => expect(onReady).toHaveBeenCalledOnce());
    const { adapter, owner, segmentList, previewLease } =
      onReady.mock.calls[0]![0];
    const frozen = snapshot();
    const signal = new AbortController().signal;
    await act(async () => {
      await adapter.prepare({
        sessionId: 1,
        sourceKey: frozen.sourceKey,
        signal,
      });
    });
    let response!: Awaited<ReturnType<TranscriptFindAdapter["find"]>>;
    await act(async () => {
      response = await adapter.find({
        sessionId: 1,
        queryId: 1,
        sourceKey: frozen.sourceKey,
        signal,
        query: "needle",
        scopeId: "EntireTranscript",
        matchCase: false,
        wholeWord: true,
      });
    });
    if (response.kind !== "Ready") {
      throw new Error("Expected Transcript Find results.");
    }
    expect(response.rows).toHaveLength(2);
    const secondKey = response.rows[1]!.key;

    let previewReceipt!: Awaited<
      ReturnType<TranscriptFindAdapter["preview"]>
    >;
    let previewPromise!: ReturnType<TranscriptFindAdapter["preview"]>;
    act(() => {
      previewPromise = adapter.preview({
        sessionId: 1,
        queryId: 1,
        sourceKey: frozen.sourceKey,
        signal,
        key: secondKey,
      });
    });
    await act(async () => {
      previewReceipt = await previewPromise;
    });
    expect(previewReceipt).toMatchObject({
      kind: "Previewed",
      key: secondKey,
    });
    expect(owner.scrollTop).toBe(90);
    expect(segmentList.scrollTop).toBe(0);
    expect(
      screen.getByLabelText("Active transcript fragment"),
    ).toHaveTextContent("match");
    expect(
      screen.getByRole("mark", { name: "Current match: needle" }),
    ).toHaveAttribute("aria-current", "true");

    await act(async () => {
      await adapter.clearPresentation({
        sessionId: 1,
        sourceKey: frozen.sourceKey,
        signal,
      });
    });
    expect(screen.queryAllByRole("mark")).toHaveLength(0);
    expect(
      screen.getByLabelText("Active transcript fragment"),
    ).toHaveTextContent("match");

    await act(async () => {
      await adapter.returnToReadingPosition({
        sessionId: 1,
        sourceKey: frozen.sourceKey,
        signal,
      });
    });
    expect(owner.scrollTop).toBe(40);
    expect(segmentList.scrollTop).toBe(0);
    expect(segmentList).toHaveFocus();
    expect(
      screen.getByLabelText("Active transcript fragment"),
    ).toHaveTextContent("origin");
    expect(previewLease.isActive()).toBe(false);
  });
});

describe("Transcript Find adapter browser kernels", () => {
  it("rolls back selection and presentation when the exact occurrence never renders", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      queueMicrotask(() => callback(performance.now()));
      return 1;
    });
    const frozen = snapshot();
    const list = segmentList();
    let activeFragmentId: string | null = "origin";
    const presentations: TranscriptFindPresentation[] = [];
    const previewLease = createMediaFindPreviewLease();
    const adapter = createTranscriptFindAdapter({
      snapshot: frozen,
      getCurrentSourceKey: () => frozen.sourceKey,
      getActiveFragmentId: () => activeFragmentId,
      setActiveFragmentId: (fragmentId) => {
        activeFragmentId = fragmentId;
      },
      getSegmentList: () => list,
      getScrollOwner: () => list,
      getMatchElement: () => null,
      publishPresentation: (presentation) => {
        presentations.push(presentation);
      },
      previewLease,
      scrollPositioner: kernelScrollPositioner,
    });
    const signal = new AbortController().signal;
    await adapter.prepare({
      sessionId: 1,
      sourceKey: frozen.sourceKey,
      signal,
    });
    const response = await adapter.find({
      sessionId: 1,
      queryId: 1,
      sourceKey: frozen.sourceKey,
      signal,
      query: "needle",
      scopeId: "EntireTranscript",
      matchCase: false,
      wholeWord: true,
    });
    if (response.kind !== "Ready") {
      throw new Error("Expected Transcript Find results.");
    }

    await expect(
      adapter.preview({
        sessionId: 1,
        queryId: 1,
        sourceKey: frozen.sourceKey,
        signal,
        key: response.rows[0]!.key,
      }),
    ).rejects.toThrow("Transcript Find match element did not render.");

    expect(activeFragmentId).toBe("origin");
    expect(list.scrollTop).toBe(40);
    expect(presentations.at(-1)).toEqual({ kind: "Text" });
    expect(previewLease.isActive()).toBe(false);
  });

  it("settles a late first-preview abort so Close and reopen retain Return", async () => {
    const frozen = snapshot();
    const list = segmentList();
    let activeFragmentId: string | null = "origin";
    const publishPresentation = vi.fn();
    const previewLease = createMediaFindPreviewLease();
    const adapter = createTranscriptFindAdapter({
      snapshot: frozen,
      getCurrentSourceKey: () => frozen.sourceKey,
      getActiveFragmentId: () => activeFragmentId,
      setActiveFragmentId: (fragmentId) => {
        activeFragmentId = fragmentId;
      },
      getSegmentList: () => list,
      getScrollOwner: () => list,
      getMatchElement: () => null,
      publishPresentation,
      previewLease,
      scrollPositioner: kernelScrollPositioner,
    });
    const prepare = vi.spyOn(adapter, "prepare");
    const view = renderHook(() => {
      const paneFind = usePaneFind({
        capability: { kind: "Available", adapter },
      });
      if (paneFind.kind !== "Available") {
        throw new Error("Expected an available Transcript Pane Find.");
      }
      return paneFind.controller;
    });
    await waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));

    act(() => view.result.current.onQueryChange("needle"));
    await waitFor(() =>
      expect(publishPresentation).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "Matches" }),
      ),
    );
    act(() => {
      view.result.current.onDismiss();
      view.result.current.onOpen();
    });
    expect(prepare).toHaveBeenCalledTimes(1);

    await waitFor(() =>
      expect(
        view.result.current.returnToReadingPosition.kind,
      ).toBe("Available"),
    );
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(publishPresentation).toHaveBeenLastCalledWith({ kind: "Text" });
    expect(activeFragmentId).toBe("match");
  });
});
