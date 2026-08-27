import {
  Component,
  type ReactNode,
} from "react";
import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Highlight } from "@/lib/highlights/highlightContract";
import { useHostedTextHighlights } from "./useHostedTextHighlights";

function highlight(id: string, fragmentId: string): Highlight {
  return {
    id,
    anchor: {
      type: "fragment_offsets",
      media_id: "media-1",
      fragment_id: fragmentId,
      start_offset: 0,
      end_offset: 4,
    },
    color: "yellow",
    exact: "text",
    prefix: "",
    suffix: "",
    created_at: "2026-08-25T12:00:00Z",
    updated_at: "2026-08-25T12:00:00Z",
    author_user_id: "user-1",
    is_owner: true,
    linked_conversations: [],
    linked_note_blocks: [],
  };
}

function highlightResponse(highlights: Highlight[]): Response {
  return Response.json({ data: { highlights } });
}

function errorResponse(status: number, code: string): Response {
  return Response.json(
    { error: { code, message: "Synthetic highlight failure" } },
    { status },
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("hosted text-highlight projection", () => {
  it("accepts an empty projection as ready without speculative retries", async () => {
    const fetch = vi.fn(async () => highlightResponse([]));
    vi.stubGlobal("fetch", fetch);

    const { result } = renderHook(() =>
      useHostedTextHighlights({ mediaId: "media-1", fragmentId: "fragment-a" }),
    );

    expect(result.current.initialLoading).toBe(true);
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.initialLoading).toBe(false);
    expect(result.current.highlights).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps a superseded fragment response from overwriting the active fragment", async () => {
    const fragmentA = deferred<Response>();
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      return path.includes("fragment-a")
        ? fragmentA.promise
        : highlightResponse([highlight("highlight-b", "fragment-b")]);
    });
    vi.stubGlobal("fetch", fetch);

    const { result, rerender } = renderHook(
      ({ fragmentId }: { fragmentId: string }) =>
        useHostedTextHighlights({ mediaId: "media-1", fragmentId }),
      { initialProps: { fragmentId: "fragment-a" } },
    );
    rerender({ fragmentId: "fragment-b" });

    await waitFor(() =>
      expect(result.current.highlights.map((item) => item.id)).toEqual([
        "highlight-b",
      ]),
    );
    fragmentA.resolve(
      highlightResponse([highlight("highlight-a", "fragment-a")]),
    );
    await act(async () => {
      await fragmentA.promise;
      await Promise.resolve();
    });

    expect(result.current.highlights.map((item) => item.id)).toEqual([
      "highlight-b",
    ]);
  });

  it("models a client failure with an explicit Retry action", async () => {
    let shouldFail = true;
    const fetch = vi.fn(async () =>
      shouldFail
        ? errorResponse(400, "E_INVALID_REQUEST")
        : highlightResponse([highlight("highlight-a", "fragment-a")]),
    );
    vi.stubGlobal("fetch", fetch);

    const { result } = renderHook(() =>
      useHostedTextHighlights({ mediaId: "media-1", fragmentId: "fragment-a" }),
    );
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(fetch).toHaveBeenCalledTimes(1);

    shouldFail = false;
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.highlights).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("uses the shared bounded retry policy for transient server failures", async () => {
    let failures = 2;
    const fetch = vi.fn(async () => {
      if (failures > 0) {
        failures -= 1;
        return errorResponse(502, "E_UPSTREAM");
      }
      return highlightResponse([highlight("highlight-a", "fragment-a")]);
    });
    vi.stubGlobal("fetch", fetch);

    const { result } = renderHook(() =>
      useHostedTextHighlights({ mediaId: "media-1", fragmentId: "fragment-a" }),
    );

    await waitFor(
      () => expect(result.current.status).toBe("ready"),
      { timeout: 2_500 },
    );
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("projects and reconciles only the latest active mutation session", async () => {
    const authoritative = [highlight("highlight-b", "fragment-a")];
    const fragmentB = deferred<Response>();
    const fetch = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(
        highlightResponse([highlight("highlight-a", "fragment-a")]),
      )
      .mockResolvedValueOnce(highlightResponse(authoritative))
      .mockImplementationOnce(() => fragmentB.promise);
    vi.stubGlobal("fetch", fetch);

    const { result, rerender, unmount } = renderHook(
      ({ fragmentId }: { fragmentId: string }) =>
        useHostedTextHighlights({ mediaId: "media-1", fragmentId }),
      { initialProps: { fragmentId: "fragment-a" } },
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    const currentSession = result.current.beginMutation();
    if (currentSession === null) throw new Error("Expected a mutation session");
    act(() => {
      expect(
        result.current.projectMutation(currentSession, () => [
          highlight("highlight-optimistic", "fragment-a"),
        ]),
      ).toBe(true);
    });
    await act(async () => {
      await result.current.reconcileMutation(currentSession);
    });
    expect(result.current.highlights).toEqual(authoritative);

    const staleSession = result.current.beginMutation();
    if (staleSession === null) throw new Error("Expected a mutation session");
    rerender({ fragmentId: "fragment-b" });
    expect(
      result.current.projectMutation(staleSession, () => [
        highlight("stale", "fragment-a"),
      ]),
    ).toBe(false);
    expect(result.current.highlights).toEqual([]);
    unmount();
  });

  it("sends malformed same-system payloads to the render defect boundary", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ data: { highlights: [{ id: "bad" }] } }),
      ),
    );

    class DefectBoundary extends Component<
      { content: ReactNode },
      { failed: boolean }
    > {
      state = { failed: false };

      static getDerivedStateFromError() {
        return { failed: true };
      }
      render() {
        return this.state.failed ? (
          <p>Highlight defect boundary</p>
        ) : (
          this.props.content
        );
      }
    }

    function Probe() {
      useHostedTextHighlights({ mediaId: "media-1", fragmentId: "fragment-a" });
      return <p>Highlight projection mounted</p>;
    }

    render(<DefectBoundary content={<Probe />} />);

    expect(await screen.findByText("Highlight defect boundary")).toBeVisible();
  });
});
