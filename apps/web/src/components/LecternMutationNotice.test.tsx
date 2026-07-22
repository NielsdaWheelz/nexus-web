/**
 * Shell mutation-notice tests (spec §6 / fix B1). Prove the shell-level surface
 * that unblocks a parked FIFO lane: a timed-out non-completion mutation shows a
 * same-ID Retry that re-sends the identical frozen body and clears on success,
 * and a failed reconciliation GET shows the GET-only variant.
 *
 * These drive the real LecternProvider + GlobalPlayerProvider through a fetch spy
 * (no internal mocks); the player session stays Absent, so the notice is never
 * suppressed as a completion attempt.
 */

import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import LecternMutationNotice from "@/components/LecternMutationNotice";
import {
  LECTERN_COMMAND_DEADLINE_MS,
  LecternProvider,
  useLectern,
} from "@/lib/lectern/LecternProvider";
import { GlobalPlayerProvider } from "@/lib/player/globalPlayer";
import { assumeMediaId } from "@/lib/lectern/contract";

const MEDIA_X = "11111111-0000-4000-8000-00000000000a";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ error: { code, message } }, status);
}

function hangUntilAbort(signal: AbortSignal | null): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const onAbort = () => reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

interface MutationMock {
  handlers: {
    get: (signal: AbortSignal | null) => Promise<Response>;
    postLectern: (body: string | null, signal: AbortSignal | null) => Promise<Response>;
  };
  lecternPostBodies: () => (string | null)[];
}

function installMock(): MutationMock {
  const lecternPosts: (string | null)[] = [];
  const handlers: MutationMock["handlers"] = {
    get: async () => jsonResponse({ data: { items: [] } }),
    postLectern: async () =>
      jsonResponse({ data: { outcome: { kind: "Placed", itemIds: [] }, lectern: { items: [] } } }),
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : null;
    const signal = init?.signal ?? null;
    if (url.pathname === "/api/lectern" && method === "GET") return handlers.get(signal);
    if (url.pathname === "/api/lectern/commands" && method === "POST") {
      lecternPosts.push(body);
      return handlers.postLectern(body, signal);
    }
    throw new Error(`unexpected fetch: ${method} ${url.pathname}`);
  });
  return { handlers, lecternPostBodies: () => lecternPosts };
}

function Harness() {
  const { placeItems, resource } = useLectern();
  return (
    <>
      <span data-testid="lectern-status">{resource.status}</span>
      <button
        type="button"
        onClick={() => {
          placeItems({ mediaIds: [assumeMediaId(MEDIA_X)], placement: { kind: "Last" } }).catch(
            () => {},
          );
        }}
      >
        Place
      </button>
      <LecternMutationNotice />
    </>
  );
}

function App({ children }: { children?: ReactNode }) {
  return (
    <LecternProvider>
      <GlobalPlayerProvider>
        <Harness />
        {children}
      </GlobalPlayerProvider>
    </LecternProvider>
  );
}

async function drain(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("LecternMutationNotice", () => {
  it("shows a same-ID Retry on a timed-out mutation, re-sends the identical body, and clears on success", async () => {
    const mock = installMock();
    let postCount = 0;
    mock.handlers.postLectern = (_body, signal) => {
      postCount += 1;
      if (postCount === 1) return hangUntilAbort(signal); // first attempt hits the deadline
      return Promise.resolve(
        jsonResponse({ data: { outcome: { kind: "Placed", itemIds: [] }, lectern: { items: [] } } }),
      );
    };

    render(<App />);
    await screen.findByText("ready", { selector: '[data-testid="lectern-status"]' });

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Place" }));
    await drain(); // let the first POST reach the network and hang
    expect(postCount).toBe(1);
    expect(screen.queryByText("Couldn't update the Lectern.")).toBeNull();

    // Cross the 35s deadline → unknown outcome → parked RetryableFailure → banner.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LECTERN_COMMAND_DEADLINE_MS);
    });
    const banner = screen.getByRole("alert");
    expect(banner).toHaveTextContent("Couldn't update the Lectern.");

    // Retry re-sends the exact frozen body (same clientMutationId), then succeeds.
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await drain();
    await drain();

    const bodies = mock.lecternPostBodies();
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).not.toBeNull();
    expect(bodies[0]).toBe(bodies[1]); // hang + retry are byte-identical
    expect(screen.queryByText("Couldn't update the Lectern.")).toBeNull();
  });

  it("shows a GET-only Retry when the reconciliation GET fails, and clears when it succeeds", async () => {
    const mock = installMock();
    let getCount = 0;
    mock.handlers.get = async () => {
      getCount += 1;
      if (getCount === 2) return errorResponse(503, "E_UPSTREAM", "reconcile boom");
      return jsonResponse({ data: { items: [] } });
    };
    // A definitive 4xx forces one reconciliation GET (which fails on getCount === 2).
    mock.handlers.postLectern = async () => errorResponse(404, "E_NOT_FOUND", "gone");

    render(<App />);
    await screen.findByText("ready", { selector: '[data-testid="lectern-status"]' });

    fireEvent.click(screen.getByRole("button", { name: "Place" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Couldn't reload the Lectern."),
    );

    // GET-only Retry re-runs the reconciliation GET (never the definitive command);
    // it succeeds and clears the banner.
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByText("Couldn't reload the Lectern.")).toBeNull());
    expect(getCount).toBe(3); // initial + failed reconcile + successful GET-only retry
  });
});
