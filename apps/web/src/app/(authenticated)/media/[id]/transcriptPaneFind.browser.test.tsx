import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Fragment } from "@/lib/media/transcriptView";
import type { PaneFindResultKey } from "@/lib/panes/paneSearch";
import { usePaneFind } from "@/lib/panes/usePaneFind";
import type { TranscriptFindPresentation } from "./TranscriptContentPanel";
import {
  createTranscriptFindAdapter,
  createTranscriptFindSnapshot,
} from "./transcriptPaneFind";

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

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("Transcript Find preview and Return", () => {
  it("targets the exact same-segment occurrence and restores selection, nested scroll, and focus", async () => {
    const frozen = snapshot();
    const list = segmentList();
    let activeFragmentId: string | null = "origin";
    const elements = new Map<PaneFindResultKey, HTMLSpanElement>();
    const presentations: TranscriptFindPresentation[] = [];
    const setActiveFragmentId = vi.fn((fragmentId: string | null) => {
      activeFragmentId = fragmentId;
    });
    const publishPresentation = vi.fn(
      (presentation: TranscriptFindPresentation) => {
        presentations.push(presentation);
        elements.clear();
        if (presentation.kind === "Text") return;
        for (const occurrence of presentation.occurrences) {
          const element = document.createElement("span");
          element.textContent = "needle";
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
          list.append(element);
          elements.set(occurrence.key, element);
        }
      },
    );
    const adapter = createTranscriptFindAdapter({
      snapshot: frozen,
      getCurrentSourceKey: () => frozen.sourceKey,
      getActiveFragmentId: () => activeFragmentId,
      setActiveFragmentId,
      getSegmentList: () => list,
      getMatchElement: (key) => elements.get(key) ?? null,
      publishPresentation,
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
    expect(response.rows).toHaveLength(2);
    const secondKey = response.rows[1]!.key;

    await expect(
      adapter.preview({
        sessionId: 1,
        queryId: 1,
        sourceKey: frozen.sourceKey,
        signal,
        key: secondKey,
      }),
    ).resolves.toMatchObject({ kind: "Previewed", key: secondKey });
    expect(setActiveFragmentId).toHaveBeenLastCalledWith("match");
    expect(list.scrollTop).toBe(90);
    expect(presentations.at(-1)).toEqual({
      kind: "Matches",
      occurrences: [
        {
          key: response.rows[0]!.key,
          fragmentId: "match",
          startCp: 0,
          endCp: 6,
        },
        {
          key: secondKey,
          fragmentId: "match",
          startCp: 12,
          endCp: 18,
        },
      ],
      activeKey: secondKey,
    });

    await adapter.clearPresentation({
      sessionId: 1,
      sourceKey: frozen.sourceKey,
      signal,
    });
    expect(presentations.at(-1)).toEqual({ kind: "Text" });
    expect(activeFragmentId).toBe("match");

    await adapter.returnToReadingPosition({
      sessionId: 1,
      sourceKey: frozen.sourceKey,
      signal,
    });
    expect(setActiveFragmentId).toHaveBeenLastCalledWith("origin");
    expect(list.scrollTop).toBe(40);
    expect(list).toHaveFocus();
  });

  it("rolls back selection and presentation when the exact occurrence never renders", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      queueMicrotask(() => callback(performance.now()));
      return 1;
    });
    const frozen = snapshot();
    const list = segmentList();
    let activeFragmentId: string | null = "origin";
    const presentations: TranscriptFindPresentation[] = [];
    const adapter = createTranscriptFindAdapter({
      snapshot: frozen,
      getCurrentSourceKey: () => frozen.sourceKey,
      getActiveFragmentId: () => activeFragmentId,
      setActiveFragmentId: (fragmentId) => {
        activeFragmentId = fragmentId;
      },
      getSegmentList: () => list,
      getMatchElement: () => null,
      publishPresentation: (presentation) => {
        presentations.push(presentation);
      },
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
  });

  it("settles a late first-preview abort so Close and reopen retain Return", async () => {
    const frozen = snapshot();
    const list = segmentList();
    let activeFragmentId: string | null = "origin";
    const publishPresentation = vi.fn();
    const adapter = createTranscriptFindAdapter({
      snapshot: frozen,
      getCurrentSourceKey: () => frozen.sourceKey,
      getActiveFragmentId: () => activeFragmentId,
      setActiveFragmentId: (fragmentId) => {
        activeFragmentId = fragmentId;
      },
      getSegmentList: () => list,
      getMatchElement: () => null,
      publishPresentation,
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
