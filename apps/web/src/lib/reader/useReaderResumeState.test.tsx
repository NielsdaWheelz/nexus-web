import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useReaderResumeState } from "./useReaderResumeState";
import type { ReaderResumeState } from "./types";

type ApiFetch = NonNullable<Parameters<typeof useReaderResumeState>[0]["apiFetch"]>;

const PDF_RESUME_STATE: ReaderResumeState = {
  kind: "pdf",
  position: 2,
  page: 2,
  page_progression: 0.4,
  zoom: 1.25,
};

describe("useReaderResumeState", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts loading for an active media id until the first state load resolves", async () => {
    let resolveFetch: ((value: unknown) => void) | null = null;
    const apiFetch: ApiFetch = async <T,>() =>
      new Promise<T>((resolve) => {
        resolveFetch = resolve as (value: unknown) => void;
      });

    const { result } = renderHook(() =>
      useReaderResumeState({
        mediaId: "media-1",
        apiFetch,
      })
    );

    expect(result.current.loading).toBe(true);
    expect(result.current.state).toBeNull();

    await act(async () => {
      resolveFetch?.({ data: PDF_RESUME_STATE });
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.state).toEqual(PDF_RESUME_STATE);
    });
  });

  it("returns to loading and clears stale state when the media id changes", async () => {
    const nextTextState: ReaderResumeState = {
      kind: "web",
      target: { fragment_id: "fragment-2" },
      locations: {
        text_offset: 84,
        progression: 0.35,
        total_progression: 0.7,
        position: 2,
      },
      text: {
        quote: "second fragment quote",
        quote_prefix: "before ",
        quote_suffix: " after",
      },
    };
    const apiFetchImpl: ApiFetch = async <T,>(path: string) => {
      if (path === "/api/media/media-1/reader-state") {
        return { data: PDF_RESUME_STATE } as T;
      }
      if (path === "/api/media/media-2/reader-state") {
        return { data: nextTextState } as T;
      }
      throw new Error(`Unexpected request: ${path}`);
    };

    const { result, rerender } = renderHook(
      ({ mediaId }: { mediaId: string | null }) =>
        useReaderResumeState({
          mediaId,
          apiFetch: apiFetchImpl,
        }),
      {
        initialProps: { mediaId: "media-1" },
      }
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.state).toEqual(PDF_RESUME_STATE);
    });

    rerender({ mediaId: "media-2" });

    expect(result.current.loading).toBe(true);
    expect(result.current.state).toBeNull();

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.state).toMatchObject({
        kind: "web",
        target: { fragment_id: "fragment-2" },
      });
    });
  });

  it("does not save when the next locator matches the current state", async () => {
    const apiFetchImpl = async <T,>(path: string, init?: RequestInit): Promise<T> => {
      if (path === "/api/media/media-1/reader-state" && !init) {
        return { data: PDF_RESUME_STATE } as T;
      }
      if (path === "/api/media/media-1/reader-state" && init?.method === "PUT") {
        return { data: PDF_RESUME_STATE } as T;
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
      expect(result.current.state).toEqual(PDF_RESUME_STATE);
    });

    vi.useFakeTimers();

    act(() => {
      result.current.save({ ...PDF_RESUME_STATE });
    });

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith("/api/media/media-1/reader-state");
  });

  it("flushes the latest pending resume state on pagehide", async () => {
    const nextResumeState: ReaderResumeState = {
      kind: "web",
      target: { fragment_id: "fragment-2" },
      locations: {
        text_offset: 84,
        progression: 0.35,
        total_progression: 0.7,
        position: 2,
      },
      text: {
        quote: "second fragment quote",
        quote_prefix: "before ",
        quote_suffix: " after",
      },
    };
    const apiFetchImpl = async <T,>(path: string, init?: RequestInit): Promise<T> => {
      if (path === "/api/media/media-1/reader-state" && !init) {
        return { data: null } as T;
      }
      if (path === "/api/media/media-1/reader-state" && init?.method === "PUT") {
        expect(init.body).toBe(JSON.stringify(nextResumeState));
        return { data: nextResumeState } as T;
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
      result.current.save(nextResumeState);
    });

    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
    });

    await waitFor(() => {
      expect(result.current.state).toEqual(nextResumeState);
    });

    expect(apiFetch).toHaveBeenNthCalledWith(2, "/api/media/media-1/reader-state", {
      method: "PUT",
      body: JSON.stringify(nextResumeState),
    });
  });

  it("rejects removed flat payloads when hydrating reader state", async () => {
    const apiFetchImpl = async <T,>(path: string): Promise<T> => {
      if (path === "/api/media/media-1/reader-state") {
        return {
          data: {
            source: "fragment-2",
            text_offset: 84,
          },
        } as T;
      }
      throw new Error(`Unexpected request: ${path}`);
    };

    const { result } = renderHook(() =>
      useReaderResumeState({
        mediaId: "media-1",
        apiFetch: apiFetchImpl as typeof apiFetchImpl,
      })
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.state).toBeNull();
  });
});
