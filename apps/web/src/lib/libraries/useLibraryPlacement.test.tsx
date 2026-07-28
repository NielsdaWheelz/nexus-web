import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { absent } from "@/lib/api/presence";
import type { LibraryPlacementSession } from "@/lib/libraries/placementController";
import { useLibraryPlacement } from "@/lib/libraries/useLibraryPlacement";

const LIB_A = "00000000-0000-4000-8000-000000000001";
const LIB_B = "00000000-0000-4000-8000-000000000002";

const session: LibraryPlacementSession = {
  key: 1,
  target: { kind: "Media", id: "media-1" },
  options: { anchor: () => null, returnFocusFallback: absent() },
};

function wireRow(id: string, name: string, inLibrary: boolean) {
  return {
    id,
    name,
    color: null,
    is_in_library: inLibrary,
    can_add: !inLibrary,
    can_remove: inLibrary,
  };
}

function listResponse(...rows: ReturnType<typeof wireRow>[]) {
  return Response.json({ data: rows });
}

function apiError(status: number, code: string) {
  return Response.json(
    { error: { code, message: "Request failed", request_id: "req-1" } },
    { status },
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function methodOf(init?: RequestInit): string {
  return (init?.method ?? "GET").toUpperCase();
}

function renderPlacement() {
  return renderHook(({ session }) => useLibraryPlacement(session), {
    initialProps: { session },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useLibraryPlacement", () => {
  it("loads authoritative rows and becomes ready", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => listResponse(wireRow(LIB_A, "Research", false))),
    );

    const { result } = renderPlacement();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.commandsDisabled).toBe(false);
    expect(result.current.failure).toBeNull();
    expect(result.current.libraries).toHaveLength(1);
    expect(result.current.libraries[0]?.isInLibrary).toBe(false);
  });

  it("projects no membership before 204, flips only after 204, and stays disabled until reconciliation", async () => {
    let gets = 0;
    const command = deferred<Response>();
    const reconcile = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (methodOf(init) === "POST") return command.promise;
        gets += 1;
        if (gets === 1) return listResponse(wireRow(LIB_A, "Research", false));
        return reconcile.promise;
      }),
    );

    const { result } = renderPlacement();
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      result.current.addToLibrary(LIB_A);
    });

    // Mutating: command in flight, no projection yet, all commands disabled.
    await waitFor(() => expect(result.current.pendingLibraryId).toBe(LIB_A));
    expect(result.current.libraries[0]?.isInLibrary).toBe(false);
    expect(result.current.commandsDisabled).toBe(true);
    expect(result.current.loading).toBe(false);

    await act(async () => {
      command.resolve(new Response(null, { status: 204 }));
      await command.promise;
    });

    // Reconciling: the confirmed flip shows immediately, reconcile GET in
    // flight, commands still disabled.
    await waitFor(() =>
      expect(result.current.libraries[0]?.isInLibrary).toBe(true),
    );
    expect(result.current.commandsDisabled).toBe(true);
    expect(result.current.loading).toBe(true);
    expect(result.current.pendingLibraryId).toBe(LIB_A);

    await act(async () => {
      reconcile.resolve(listResponse(wireRow(LIB_A, "Research", true)));
      await reconcile.promise;
    });

    // Ready: authoritative rows replace the overlay, commands re-enabled.
    await waitFor(() => expect(result.current.commandsDisabled).toBe(false));
    expect(result.current.loading).toBe(false);
    expect(result.current.pendingLibraryId).toBeNull();
    expect(result.current.libraries[0]?.isInLibrary).toBe(true);
  });

  it("offers Retry on a transient reconcile failure and recovers on retry", async () => {
    let gets = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (methodOf(init) === "POST") return new Response(null, { status: 204 });
        gets += 1;
        if (gets === 1) return listResponse(wireRow(LIB_A, "Research", false));
        if (gets === 2) throw new TypeError("offline during reconciliation");
        return listResponse(wireRow(LIB_A, "Research", true));
      }),
    );

    const { result } = renderPlacement();
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      result.current.addToLibrary(LIB_A);
    });

    await waitFor(() => expect(result.current.failure?.kind).toBe("Retry"));
    // Confirmed flip stays visible, commands disabled while awaiting a retry.
    expect(result.current.libraries[0]?.isInLibrary).toBe(true);
    expect(result.current.commandsDisabled).toBe(true);
    expect(result.current.pendingLibraryId).toBe(LIB_A);

    const failure = result.current.failure;
    await act(async () => {
      if (failure?.kind === "Retry") failure.retry();
    });

    await waitFor(() => expect(result.current.commandsDisabled).toBe(false));
    expect(result.current.failure).toBeNull();
    expect(result.current.libraries[0]?.isInLibrary).toBe(true);
  });

  it("marks the target unavailable when reconciliation reports it is gone", async () => {
    let gets = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (methodOf(init) === "POST") return new Response(null, { status: 204 });
        gets += 1;
        if (gets === 1) return listResponse(wireRow(LIB_A, "Research", false));
        return apiError(404, "E_MEDIA_NOT_FOUND");
      }),
    );

    const { result } = renderPlacement();
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      result.current.addToLibrary(LIB_A);
    });

    await waitFor(() => expect(result.current.failure?.kind).toBe("Terminal"));
    expect(result.current.commandsDisabled).toBe(true);
    expect(result.current.loading).toBe(false);
  });

  it("preserves prior rows on a transient command failure and reruns the command on retry", async () => {
    let posts = 0;
    let gets = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (methodOf(init) === "POST") {
          posts += 1;
          if (posts === 1) throw new TypeError("connection reset");
          return new Response(null, { status: 204 });
        }
        gets += 1;
        if (gets === 1) return listResponse(wireRow(LIB_A, "Research", false));
        return listResponse(wireRow(LIB_A, "Research", true));
      }),
    );

    const { result } = renderPlacement();
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      result.current.addToLibrary(LIB_A);
    });

    await waitFor(() => expect(result.current.failure?.kind).toBe("Retry"));
    // No overlay: prior authoritative state survives; rows remain actionable.
    expect(result.current.libraries[0]?.isInLibrary).toBe(false);
    expect(result.current.commandsDisabled).toBe(false);
    expect(result.current.pendingLibraryId).toBeNull();

    const failure = result.current.failure;
    await act(async () => {
      if (failure?.kind === "Retry") failure.retry();
    });

    await waitFor(() =>
      expect(result.current.libraries[0]?.isInLibrary).toBe(true),
    );
    expect(result.current.commandsDisabled).toBe(false);
    expect(posts).toBe(2);
  });

  it("runs one mutation at a time and ignores a second command while one is in flight", async () => {
    let posts = 0;
    let gets = 0;
    const command = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (methodOf(init) === "POST") {
          posts += 1;
          return command.promise;
        }
        gets += 1;
        if (gets === 1) {
          return listResponse(
            wireRow(LIB_A, "Research", false),
            wireRow(LIB_B, "Reading", false),
          );
        }
        return listResponse(
          wireRow(LIB_A, "Research", true),
          wireRow(LIB_B, "Reading", false),
        );
      }),
    );

    const { result } = renderPlacement();
    await waitFor(() => expect(result.current.libraries).toHaveLength(2));

    act(() => {
      result.current.addToLibrary(LIB_A);
      result.current.addToLibrary(LIB_B);
    });

    expect(posts).toBe(1);
    expect(result.current.pendingLibraryId).toBe(LIB_A);
    expect(result.current.commandsDisabled).toBe(true);

    await act(async () => {
      command.resolve(new Response(null, { status: 204 }));
      await command.promise;
    });
    await waitFor(() => expect(result.current.commandsDisabled).toBe(false));
    expect(posts).toBe(1);
  });

  it("marks the target unavailable when the initial load reports it is gone", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => apiError(404, "E_NOT_FOUND")),
    );

    const { result } = renderPlacement();

    await waitFor(() => expect(result.current.failure?.kind).toBe("Terminal"));
    expect(result.current.commandsDisabled).toBe(true);
    expect(result.current.loading).toBe(false);
    expect(result.current.libraries).toEqual([]);
  });
});
