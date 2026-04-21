import { renderHook, act, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { useReaderResumeState } from "./useReaderResumeState";
import type { ReaderResumeState } from "./types";

const PDF_READER_RESUME_STATE: ReaderResumeState = {
  locator: {
    kind: "pdf_page",
    page: 2,
    zoom: 1.25,
  },
};

describe("useReaderResumeState", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not save when the next whole-state locator matches the current state", async () => {
    const apiFetchImpl = async <T,>(path: string, init?: RequestInit): Promise<T> => {
      if (path === "/api/media/media-1/reader-state" && !init) {
        return { data: PDF_READER_RESUME_STATE } as T;
      }
      if (path === "/api/media/media-1/reader-state" && init?.method === "PUT") {
        return { data: PDF_READER_RESUME_STATE } as T;
      }
      throw new Error(`Unexpected request: ${path}`);
    };
    const apiFetch = vi.fn(apiFetchImpl);

    const { result } = renderHook(() =>
      useReaderResumeState({
        mediaId: "media-1",
        apiFetch: apiFetch as typeof apiFetchImpl,
        debounceMs: 0,
      })
    );

    await waitFor(() => {
      expect(result.current.state).toEqual(PDF_READER_RESUME_STATE);
    });

    vi.useFakeTimers();

    act(() => {
      result.current.save({
        locator: {
          kind: "pdf_page",
          page: 2,
          zoom: 1.25,
        },
      });
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith("/api/media/media-1/reader-state");
  });

  it("normalizes legacy GET responses and falls back to PATCH when PUT is unavailable", async () => {
    const apiFetchImpl = async <T,>(path: string, init?: RequestInit): Promise<T> => {
      if (path === "/api/media/media-1/reader-state" && !init) {
        return {
          data: {
            locator_kind: "fragment_offset",
            fragment_id: "fragment-1",
            offset: 42,
            section_id: null,
            page: null,
            zoom: null,
          },
        } as T;
      }
      if (path === "/api/media/media-1/reader-state" && init?.method === "PUT") {
        throw new ApiError(405, "E_METHOD_NOT_ALLOWED", "Method not allowed");
      }
      if (path === "/api/media/media-1/reader-state" && init?.method === "PATCH") {
        expect(init.body).toBe(
          JSON.stringify({
            locator_kind: "epub_section",
            fragment_id: null,
            offset: null,
            section_id: "chapter-2",
            page: null,
            zoom: null,
          })
        );
        return {
          data: {
            locator_kind: "epub_section",
            fragment_id: null,
            offset: null,
            section_id: "chapter-2",
            page: null,
            zoom: null,
          },
        } as T;
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
      expect(result.current.state).toEqual({
        locator: {
          kind: "fragment_offset",
          fragment_id: "fragment-1",
          offset: 42,
        },
      });
    });

    act(() => {
      result.current.save({
        locator: {
          kind: "epub_section",
          section_id: "chapter-2",
        },
      });
    });

    await waitFor(() => {
      expect(result.current.state).toEqual({
        locator: {
          kind: "epub_section",
          section_id: "chapter-2",
        },
      });
    });

    expect(apiFetch).toHaveBeenNthCalledWith(2, "/api/media/media-1/reader-state", {
      method: "PUT",
      body: JSON.stringify({
        locator: {
          kind: "epub_section",
          section_id: "chapter-2",
        },
      }),
    });
    expect(apiFetch).toHaveBeenNthCalledWith(3, "/api/media/media-1/reader-state", {
      method: "PATCH",
      body: JSON.stringify({
        locator_kind: "epub_section",
        fragment_id: null,
        offset: null,
        section_id: "chapter-2",
        page: null,
        zoom: null,
      }),
    });
  });
});
