import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useNonDefaultLibraries } from "./useNonDefaultLibraries";

function librariesResponse() {
  return Response.json({
    data: [
      {
        id: "library-default",
        name: "Default",
        is_default: true,
        color: null,
      },
      {
        id: "library-1",
        name: "Research",
        is_default: false,
        color: "#114455",
      },
    ],
  });
}

describe("useNonDefaultLibraries", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps load stable and makes successful loads terminal", async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );

    const { result, rerender } = renderHook(() => useNonDefaultLibraries());
    const load = result.current.load;
    let firstLoad!: Promise<void>;
    let secondLoad!: Promise<void>;

    act(() => {
      firstLoad = result.current.load();
      secondLoad = result.current.load();
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.current.load).toBe(load);

    await act(async () => {
      resolveFetch?.(librariesResponse());
      await firstLoad;
      await secondLoad;
    });

    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.libraries).toEqual([
      {
        id: "library-1",
        name: "Research",
        color: "#114455",
        isInLibrary: false,
        canAdd: true,
        canRemove: false,
      },
    ]);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.load).toBe(load);

    rerender();
    expect(result.current.load).toBe(load);

    await act(async () => {
      await result.current.load();
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("treats failure as terminal until retry", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json(
          {
            error: {
              code: "E_UPSTREAM",
              message: "Backend service timed out",
            },
          },
          { status: 504 },
        ),
      )
      .mockResolvedValueOnce(librariesResponse());

    const { result } = renderHook(() => useNonDefaultLibraries());
    const load = result.current.load;

    await act(async () => {
      await result.current.load();
    });

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.loaded).toBe(false);
    expect(result.current.loading).toBe(false);
    expect(result.current.load).toBe(load);

    await act(async () => {
      await result.current.load();
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.retry();
    });

    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.error).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
