import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useReaderResumeState } from "./useReaderResumeState";
import type { ReaderLocator } from "./types";

const PDF_LOCATOR: ReaderLocator = {
  source: null,
  anchor: null,
  text_offset: null,
  quote: null,
  quote_prefix: null,
  quote_suffix: null,
  progression: null,
  total_progression: null,
  position: 2,
  page: 2,
  page_progression: 0.4,
  zoom: 1.25,
};

describe("useReaderResumeState", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not save when the next locator matches the current state", async () => {
    const apiFetchImpl = async <T,>(path: string, init?: RequestInit): Promise<T> => {
      if (path === "/api/media/media-1/reader-state" && !init) {
        return { data: PDF_LOCATOR } as T;
      }
      if (path === "/api/media/media-1/reader-state" && init?.method === "PUT") {
        return { data: PDF_LOCATOR } as T;
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
      expect(result.current.state).toEqual(PDF_LOCATOR);
    });

    vi.useFakeTimers();

    act(() => {
      result.current.save({ ...PDF_LOCATOR });
    });

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith("/api/media/media-1/reader-state");
  });

  it("flushes the latest pending locator on pagehide", async () => {
    const nextLocator: ReaderLocator = {
      source: "fragment-2",
      anchor: null,
      text_offset: 84,
      quote: "second fragment quote",
      quote_prefix: "before ",
      quote_suffix: " after",
      progression: 0.35,
      total_progression: 0.7,
      position: 2,
      page: null,
      page_progression: null,
      zoom: null,
    };
    const apiFetchImpl = async <T,>(path: string, init?: RequestInit): Promise<T> => {
      if (path === "/api/media/media-1/reader-state" && !init) {
        return { data: null } as T;
      }
      if (path === "/api/media/media-1/reader-state" && init?.method === "PUT") {
        expect(init.body).toBe(JSON.stringify(nextLocator));
        return { data: nextLocator } as T;
      }
      throw new Error(`Unexpected request: ${path}`);
    };
    const apiFetch = vi.fn(apiFetchImpl);

    const { result } = renderHook(() =>
      useReaderResumeState({
        mediaId: "media-1",
        apiFetch: apiFetch as typeof apiFetchImpl,
        debounceMs: 10_000,
      })
    );

    await waitFor(() => {
      expect(result.current.state).toBeNull();
    });

    act(() => {
      result.current.save(nextLocator);
    });

    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
    });

    await waitFor(() => {
      expect(result.current.state).toEqual(nextLocator);
    });

    expect(apiFetch).toHaveBeenNthCalledWith(2, "/api/media/media-1/reader-state", {
      method: "PUT",
      body: JSON.stringify(nextLocator),
    });
  });
});
