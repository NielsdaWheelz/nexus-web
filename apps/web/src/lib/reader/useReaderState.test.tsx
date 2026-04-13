import { renderHook, act, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useReaderState } from "./useReaderState";
import type { ReaderState } from "./types";

const READER_STATE: ReaderState = {
  theme: "light",
  font_family: "serif",
  font_size_px: 16,
  line_height: 1.5,
  column_width_ch: 65,
  focus_mode: false,
  view_mode: "scroll",
  locator_kind: "pdf_page",
  fragment_id: null,
  offset: null,
  section_id: null,
  page: 2,
  zoom: 1.25,
};

describe("useReaderState", () => {
  it("does not patch when the next save matches the current state", async () => {
    const apiFetchImpl = async <T,>(path: string, init?: RequestInit): Promise<T> => {
      if (path === "/api/media/media-1/reader-state" && !init) {
        return { data: READER_STATE } as T;
      }
      if (path === "/api/media/media-1/reader-state" && init?.method === "PATCH") {
        return { data: READER_STATE } as T;
      }
      throw new Error(`Unexpected request: ${path}`);
    };
    const apiFetch = vi.fn(apiFetchImpl);

    const { result } = renderHook(() =>
      useReaderState({
        mediaId: "media-1",
        apiFetch: apiFetch as typeof apiFetchImpl,
        debounceMs: 500,
      })
    );

    await waitFor(() => {
      expect(result.current.state).toEqual(READER_STATE);
    });

    vi.useFakeTimers();

    act(() => {
      result.current.save({
        locator_kind: "pdf_page",
        page: 2,
        zoom: 1.25,
        fragment_id: null,
        offset: null,
        section_id: null,
      });
    });

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith("/api/media/media-1/reader-state");

    vi.useRealTimers();
  });
});
