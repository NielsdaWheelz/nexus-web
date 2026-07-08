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

const WEB_RESUME_STATE: ReaderResumeState = {
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

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

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
    const apiFetchImpl: ApiFetch = async <T,>(path: string) => {
      if (path === "/api/media/media-1/reader-state") {
        return { data: PDF_RESUME_STATE } as T;
      }
      if (path === "/api/media/media-2/reader-state") {
        return { data: WEB_RESUME_STATE } as T;
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

  it("lets the latest media hydration win when earlier loads resolve late", async () => {
    const media1Load = deferred<{ data: unknown }>();
    const media2Load = deferred<{ data: unknown }>();
    const apiFetchImpl: ApiFetch = async <T,>(path: string) => {
      if (path === "/api/media/media-1/reader-state") {
        return media1Load.promise as Promise<T>;
      }
      if (path === "/api/media/media-2/reader-state") {
        return media2Load.promise as Promise<T>;
      }
      throw new Error(`Unexpected request: ${path}`);
    };
    const apiFetch = vi.fn(apiFetchImpl);

    const { result, rerender } = renderHook(
      ({ mediaId }: { mediaId: string | null }) =>
        useReaderResumeState({
          mediaId,
          apiFetch: apiFetch as ApiFetch,
        }),
      {
        initialProps: { mediaId: "media-1" },
      }
    );

    rerender({ mediaId: "media-2" });
    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith("/api/media/media-2/reader-state");
    });

    await act(async () => {
      media2Load.resolve({ data: WEB_RESUME_STATE });
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.state).toEqual(WEB_RESUME_STATE);
    });

    await act(async () => {
      media1Load.resolve({ data: PDF_RESUME_STATE });
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.state).toEqual(WEB_RESUME_STATE);
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
    const nextResumeState = WEB_RESUME_STATE;
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
      keepalive: true,
    });
  });

  it("does not apply a stale save response after switching media", async () => {
    const media1Save = deferred<{ data: unknown }>();
    const apiFetchImpl = async <T,>(path: string, init?: RequestInit): Promise<T> => {
      if (path === "/api/media/media-1/reader-state" && !init) {
        return { data: null } as T;
      }
      if (path === "/api/media/media-1/reader-state" && init?.method === "PUT") {
        return media1Save.promise as Promise<T>;
      }
      if (path === "/api/media/media-2/reader-state" && !init) {
        return { data: WEB_RESUME_STATE } as T;
      }
      throw new Error(`Unexpected request: ${path}`);
    };
    const apiFetch = vi.fn(apiFetchImpl);

    const { result, rerender } = renderHook(
      ({ mediaId }: { mediaId: string | null }) =>
        useReaderResumeState({
          mediaId,
          apiFetch: apiFetch as typeof apiFetchImpl,
          debounceMs: 10_000,
        }),
      {
        initialProps: { mediaId: "media-1" },
      }
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      result.current.save(PDF_RESUME_STATE);
    });

    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
    });
    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith("/api/media/media-1/reader-state", {
        method: "PUT",
        body: JSON.stringify(PDF_RESUME_STATE),
        keepalive: true,
      });
    });

    rerender({ mediaId: "media-2" });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.state).toEqual(WEB_RESUME_STATE);
    });

    await act(async () => {
      media1Save.resolve({ data: PDF_RESUME_STATE });
    });

    await waitFor(() => {
      expect(result.current.state).toEqual(WEB_RESUME_STATE);
    });
  });

  it("folds accumulated dwell into the attention block and resets after flush", async () => {
    const putBodies: string[] = [];
    const putInits: (RequestInit | undefined)[] = [];
    const apiFetchImpl = async <T,>(path: string, init?: RequestInit): Promise<T> => {
      if (path === "/api/media/media-1/reader-state" && !init) {
        return { data: null } as T;
      }
      if (path === "/api/media/media-1/reader-state" && init?.method === "PUT") {
        putBodies.push(String(init.body));
        putInits.push(init);
        return { data: WEB_RESUME_STATE } as T;
      }
      throw new Error(`Unexpected request: ${path}`);
    };
    const dwellDeltaRef = { current: 45_000 };
    const tracker = {
      dwellDeltaRef,
      resetDelta: () => {
        dwellDeltaRef.current = 0;
      },
      deviceId: "device-x",
    };

    const { result } = renderHook(() =>
      useReaderResumeState({
        mediaId: "media-1",
        apiFetch: apiFetchImpl as typeof apiFetchImpl,
        debounceMs: 10_000,
        attention: tracker,
      })
    );

    await waitFor(() => {
      expect(result.current.state).toBeNull();
    });

    act(() => {
      result.current.save(WEB_RESUME_STATE);
    });

    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
    });

    await waitFor(() => {
      expect(putBodies).toHaveLength(1);
    });

    const body = JSON.parse(putBodies[0]) as {
      locator: { kind: string };
      attention: { dwell_ms_delta: number; device_id: string; progression: number | null };
    };
    expect(body.locator).toMatchObject({ kind: "web" });
    expect(body.attention.dwell_ms_delta).toBe(45_000);
    expect(body.attention.device_id).toBe("device-x");
    expect(body.attention.progression).toBe(0.7);
    expect(dwellDeltaRef.current).toBe(0);
    // The attention-bearing pagehide flush must be keepalive so the browser
    // sends it after navigation, same as the locator-only pagehide path.
    expect(putInits[0]?.keepalive).toBe(true);
  });

  it("sends dwell_ms_delta 0 as the opened event when no dwell accrued", async () => {
    const putBodies: string[] = [];
    const apiFetchImpl = async <T,>(path: string, init?: RequestInit): Promise<T> => {
      if (path === "/api/media/media-1/reader-state" && !init) {
        return { data: null } as T;
      }
      if (path === "/api/media/media-1/reader-state" && init?.method === "PUT") {
        putBodies.push(String(init.body));
        return { data: WEB_RESUME_STATE } as T;
      }
      throw new Error(`Unexpected request: ${path}`);
    };
    const dwellDeltaRef = { current: 0 };
    const tracker = {
      dwellDeltaRef,
      resetDelta: () => {
        dwellDeltaRef.current = 0;
      },
      deviceId: "device-x",
    };

    const { result } = renderHook(() =>
      useReaderResumeState({
        mediaId: "media-1",
        apiFetch: apiFetchImpl as typeof apiFetchImpl,
        debounceMs: 10_000,
        attention: tracker,
      })
    );

    await waitFor(() => {
      expect(result.current.state).toBeNull();
    });

    act(() => {
      result.current.save(WEB_RESUME_STATE);
    });

    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
    });

    await waitFor(() => {
      expect(putBodies).toHaveLength(1);
    });

    const body = JSON.parse(putBodies[0]) as { attention: { dwell_ms_delta: number } };
    expect(body.attention.dwell_ms_delta).toBe(0);
  });

  it("surfaces invalid API payloads when hydrating reader state", async () => {
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
    expect(result.current.error).toBe("Failed to load reader state");
  });
});
