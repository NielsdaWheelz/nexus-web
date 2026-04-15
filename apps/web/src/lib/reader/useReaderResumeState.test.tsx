import { renderHook, act, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useReaderResumeState } from "./useReaderResumeState";
import type { ReaderResumeState } from "./types";

const READER_RESUME_STATE: ReaderResumeState = {
  locator_kind: "pdf_page",
  fragment_id: null,
  offset: null,
  section_id: null,
  page: 2,
  zoom: 1.25,
};

describe("useReaderResumeState", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not patch when the next save matches the current state", async () => {
    const apiFetchImpl = async <T,>(path: string, init?: RequestInit): Promise<T> => {
      if (path === "/api/media/media-1/reader-state" && !init) {
        return { data: READER_RESUME_STATE } as T;
      }
      if (path === "/api/media/media-1/reader-state" && init?.method === "PATCH") {
        return { data: READER_RESUME_STATE } as T;
      }
      throw new Error(`Unexpected request: ${path}`);
    };
    const apiFetch = vi.fn(apiFetchImpl);

    const { result } = renderHook(() =>
      useReaderResumeState({
        mediaId: "media-1",
        apiFetch: apiFetch as typeof apiFetchImpl,
        debounceMs: 500,
      })
    );

    await waitFor(() => {
      expect(result.current.state).toEqual(READER_RESUME_STATE);
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

  });
});
