import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useReaderProfile } from "./useReaderProfile";
import { DEFAULT_READER_PROFILE, type ReaderProfile } from "./types";

type ApiFetch = NonNullable<Parameters<typeof useReaderProfile>[0]["apiFetch"]>;

const INITIAL_PROFILE: ReaderProfile = {
  ...DEFAULT_READER_PROFILE,
  theme: "light",
  font_family: "serif",
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

describe("useReaderProfile", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the initial profile without issuing any fetch", () => {
    const apiFetch = vi.fn();

    const { result } = renderHook(() =>
      useReaderProfile({ initialProfile: INITIAL_PROFILE, apiFetch: apiFetch as ApiFetch })
    );

    expect(result.current.profile).toEqual(INITIAL_PROFILE);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("optimistically updates the profile, then issues one PATCH after the debounce", async () => {
    const save = deferred<{ data: ReaderProfile }>();
    const apiFetch = vi.fn(() => save.promise);

    const { result } = renderHook(() =>
      useReaderProfile({
        initialProfile: INITIAL_PROFILE,
        apiFetch: apiFetch as unknown as ApiFetch,
        debounceMs: 20,
      })
    );

    act(() => {
      result.current.updateTheme("dark");
    });

    // Optimistic update lands immediately, before any PATCH resolves.
    expect(result.current.profile.theme).toBe("dark");
    expect(apiFetch).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledTimes(1);
    });
    expect(apiFetch).toHaveBeenCalledWith("/api/me/reader-profile", {
      method: "PATCH",
      body: JSON.stringify({ theme: "dark" }),
    });

    const serverProfile: ReaderProfile = { ...INITIAL_PROFILE, theme: "dark", font_size_px: 18 };
    await act(async () => {
      save.resolve({ data: serverProfile });
    });

    await waitFor(() => {
      expect(result.current.saving).toBe(false);
      expect(result.current.profile).toEqual(serverProfile);
    });
  });

  it("coalesces rapid edits into one PATCH that merges both fields", async () => {
    const save = deferred<{ data: ReaderProfile }>();
    const apiFetch = vi.fn(() => save.promise);

    const { result } = renderHook(() =>
      useReaderProfile({
        initialProfile: INITIAL_PROFILE,
        apiFetch: apiFetch as unknown as ApiFetch,
        debounceMs: 20,
      })
    );

    act(() => {
      result.current.updateTheme("dark");
      result.current.updateFontFamily("sans");
    });

    expect(result.current.profile.theme).toBe("dark");
    expect(result.current.profile.font_family).toBe("sans");

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledTimes(1);
    });
    expect(apiFetch).toHaveBeenCalledWith("/api/me/reader-profile", {
      method: "PATCH",
      body: JSON.stringify({ theme: "dark", font_family: "sans" }),
    });

    await act(async () => {
      save.resolve({ data: { ...INITIAL_PROFILE, theme: "dark", font_family: "sans" } });
    });
  });

  it("surfaces the error and clears the saving flag when the PATCH rejects", async () => {
    const save = deferred<{ data: ReaderProfile }>();
    const apiFetch = vi.fn(() => save.promise);

    const { result } = renderHook(() =>
      useReaderProfile({
        initialProfile: INITIAL_PROFILE,
        apiFetch: apiFetch as unknown as ApiFetch,
        debounceMs: 20,
      })
    );

    act(() => {
      result.current.updateTheme("dark");
    });

    await waitFor(() => {
      expect(result.current.saving).toBe(true);
    });

    await act(async () => {
      save.reject(new Error("boom"));
    });

    await waitFor(() => {
      expect(result.current.saving).toBe(false);
      expect(result.current.error).toBe("Failed to save reader settings");
    });
    // The optimistic update is retained even though the save failed.
    expect(result.current.profile.theme).toBe("dark");
  });

  it("issues no PATCH when unmounted before the debounce timer fires", async () => {
    const apiFetch = vi.fn();

    const { result, unmount } = renderHook(() =>
      useReaderProfile({
        initialProfile: INITIAL_PROFILE,
        apiFetch: apiFetch as ApiFetch,
        debounceMs: 50,
      })
    );

    act(() => {
      result.current.updateTheme("dark");
    });

    unmount();

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(apiFetch).not.toHaveBeenCalled();
  });
});
