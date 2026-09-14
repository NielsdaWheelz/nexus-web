import { READER_CAPACITY } from "@/lib/reader/readerCapacity";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ResourceCacheProvider } from "@/lib/api/resourceCache";
import { usePaneWarm } from "./paneWarm";

afterEach(() => vi.unstubAllGlobals());

it("withdraws an already running speculative read when intent moves away", async () => {
  let oldSignal: AbortSignal | undefined;
  const paths: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), window.location.origin).pathname;
    paths.push(path);
    if (path === "/api/libraries") {
      oldSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        oldSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    }
    return Response.json({ data: { items: [], collectionRevision: 0, nextCursor: { kind: "Absent" } } });
  });
  function Links() {
    const warm = usePaneWarm();
    return <>
      <button onMouseEnter={() => warm("/libraries")}>Libraries</button>
      <button onMouseEnter={() => warm("/conversations")}>Conversations</button>
    </>;
  }
  render(<ResourceCacheProvider value={{}} publicationLimits={READER_CAPACITY.cache}><Links /></ResourceCacheProvider>);
  fireEvent.mouseEnter(screen.getByRole("button", { name: "Libraries" }));
  await waitFor(() => expect(paths).toContain("/api/libraries"));
  fireEvent.mouseEnter(screen.getByRole("button", { name: "Conversations" }));
  await waitFor(() => expect(paths).toContain("/api/conversations"));
  expect(oldSignal?.aborted, "obsolete speculation retained its request").toBe(true);
});

it("withdraws obsolete hover intent before starting a speculative data load", async () => {
  const paths: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const path = new URL(String(input), window.location.origin).pathname;
    paths.push(path);
    return Response.json({ data: {
      items: [], collectionRevision: 0, nextCursor: { kind: "Absent" },
    } });
  });
  function Links() {
    const warm = usePaneWarm();
    return <>
      <button onMouseEnter={() => warm("/libraries")}>Libraries</button>
      <button onMouseEnter={() => warm("/conversations")}>Conversations</button>
    </>;
  }
  render(<ResourceCacheProvider value={{}} publicationLimits={READER_CAPACITY.cache}><Links /></ResourceCacheProvider>);
  fireEvent.mouseEnter(screen.getByRole("button", { name: "Libraries" }));
  fireEvent.mouseEnter(screen.getByRole("button", { name: "Conversations" }));
  await waitFor(() => expect(paths).toContain("/api/conversations"));
  expect(paths, "obsolete hover intent launched unnecessary library reads").not.toContain("/api/libraries");
});
