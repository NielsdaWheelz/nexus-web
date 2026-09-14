import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { ResourceCache, ResourceCacheContext, publicationPayloadBytes } from "@/lib/api/resourceCache";
import { READER_CAPACITY } from "@/lib/reader/readerCapacity";
import { clearPendingReaderPulse, readPendingReaderPulse, retainPendingReaderPulse, type ReaderPulseInput } from "@/lib/reader/pulseEvent";
import { PaneReturnMementoProvider } from "@/lib/workspace/paneReturnMemento";
import { createDefaultWorkspaceState } from "@/lib/workspace/schema";
import { useWorkspaceStore, WorkspaceStoreProvider } from "@/lib/workspace/store";
import { useReaderSourceActivation } from "./readerSourceActivation";
import type { MediaReaderTarget } from "./readerTarget";

const mediaId = "11111111-1111-4111-8111-111111111111";
const metrics = { primaryMinWidthPx: 684, primaryDefaultWidthPx: 684 };
const source: MediaReaderTarget = { kind: "media", source: "reader_selection", media_id: mediaId,
  locator: { type: "web_text_offsets", media_id: mediaId, fragment_id: "22222222-2222-4222-8222-222222222222",
    start_offset: 0, end_offset: 15, text_quote_selector: { exact: "original source", prefix: "", suffix: "" } },
  snippet: "original source", highlight_behavior: "pulse", focus_behavior: "scroll_into_view" };
const input: ReaderPulseInput = { mediaId, locator: source.locator, snippet: null,
  highlightBehavior: "pulse", focusBehavior: "scroll_into_view" };

function SourceLink({ target, cache }: { target: MediaReaderTarget; cache: ResourceCache }) {
  const handle = useReaderSourceActivation();
  const workspace = useWorkspaceStore();
  const [handled, setHandled] = useState(false);
  const pane = workspace.state.primaryPanesById[workspace.state.activePrimaryPaneId];
  return <>
    <a href={`/media/${mediaId}`} onClick={(event) => {
      const result = handle({ kind: "route", resourceRef: `media:${mediaId}`, href: `/media/${mediaId}`, unresolvedReason: null }, target,
        { disposition: { kind: "Follow" }, activateTarget: (request) => workspace.activateWorkspaceTarget({ ...request,
          originPaneId: workspace.state.activePrimaryPaneId, modality: "Pointer" }) });
      if (result) event.preventDefault();
      setHandled(event.defaultPrevented);
    }}>Open original source</a>
    <output aria-label="Handled source link">{String(handled)}</output>
    <output aria-label="Current reader pane">{pane.id}</output>
    <output aria-label="Current workspace location">{pane.currentVisit.href}</output>
    <button type="button" onClick={() => cache.clear()}>End account</button>
  </>;
}

function renderSource(cache: ResourceCache, target = source) {
  window.history.replaceState({}, "", "/libraries");
  return render(<ResourceCacheContext.Provider value={cache}><FeedbackProvider><PaneReturnMementoProvider>
    <WorkspaceStoreProvider initialState={createDefaultWorkspaceState("/libraries", metrics)} workspacePrimaryMetrics={metrics}>
      <SourceLink target={target} cache={cache} />
    </WorkspaceStoreProvider>
  </PaneReturnMementoProvider></FeedbackProvider></ResourceCacheContext.Provider>);
}

afterEach(() => vi.unstubAllGlobals());

it("handles refused citation links without opening a pane or retaining a pending quote", () => {
  const cache = new ResourceCache({}, { ...READER_CAPACITY.cache, maxPayloadBytes: publicationPayloadBytes(input) - 1 });
  renderSource(cache);
  fireEvent.click(screen.getByRole("link", { name: "Open original source" }));
  expect(screen.getByLabelText("Handled source link"), "capacity refusal fell through to browser navigation").toHaveTextContent("true");
  expect(screen.getByLabelText("Current workspace location").textContent).toBe("/libraries");
  expect(screen.getAllByText("There is not enough reader space to open this source.")[0]).toBeVisible();
  const paneId = screen.getByLabelText("Current reader pane").textContent!;
  expect(readPendingReaderPulse(paneId, mediaId)).toBeNull();
});

it("handles an input that cannot fit the existing selected-source request bound without retaining a retry quote", () => {
  const cache = new ResourceCache({}, READER_CAPACITY.cache);
  if (source.locator.type !== "web_text_offsets") throw new Error("Source fixture has the wrong text locator");
  const exact = "x".repeat(READER_CAPACITY.indexBytes);
  renderSource(cache, { ...source, source: "message_retrieval", locator: { ...source.locator, end_offset: exact.length,
    text_quote_selector: { exact, prefix: "", suffix: "" } } });
  fireEvent.click(screen.getByRole("link", { name: "Open original source" }));
  expect(screen.getByLabelText("Handled source link")).toHaveTextContent("true");
  expect(screen.getByLabelText("Current workspace location").textContent).toBe("/libraries");
  expect(screen.getAllByText("This source reference is too large to open.")[0]).toBeVisible();
  const paneId = screen.getByLabelText("Current reader pane").textContent!;
  expect(readPendingReaderPulse(paneId, mediaId), "an impossible source request retained a pending full quote").toBeNull();
  const available = cache.retainReaderSourceInput(input);
  expect(available.kind).toBe("Acquired");
  if (available.kind === "Acquired") available.lease.release();
});

it("retains admitted citation input until an account-withdrawn reader operation physically settles", async () => {
  const held: { finish: (() => void) | null } = { finish: null };
  vi.stubGlobal("fetch", async (request: RequestInfo | URL) => {
    const path = new URL(String(request), window.location.origin).pathname;
    if (path === "/api/me/workspace-session") return new Response(JSON.stringify({ data: null }), { headers: { "Content-Type": "application/json" } });
    if (path === "/held-source") return new Promise<Response>((resolve) => { held.finish = () => resolve(new Response("settled")); });
    throw new Error(`Unexpected source activation request: ${path}`);
  });
  const cache = new ResourceCache({}, { ...READER_CAPACITY.cache, maxPayloadBytes: publicationPayloadBytes(input) });
  const view = renderSource(cache);
  fireEvent.click(screen.getByRole("link", { name: "Open original source" }));
  expect(screen.getByLabelText("Handled source link")).toHaveTextContent("true");
  expect(screen.getByLabelText("Current workspace location").textContent).toBe(`/media/${mediaId}`);
  const paneId = screen.getByLabelText("Current reader pane").textContent!;
  const delivery = readPendingReaderPulse(paneId, mediaId);
  expect(delivery?.locator).toEqual(source.locator);
  if (delivery === null) throw new Error("Accepted source has no destination delivery");
  const controller = new AbortController();
  const read = fetch("/held-source", { signal: controller.signal }).then((response) => response.text());
  const retired = read.then(() => {});
  expect(retainPendingReaderPulse(delivery, () => { controller.abort(); return retired; })).toBe(true);
  try {
    expect(cache.retainReaderSourceInput(input), "pending source input escaped account admission").toEqual({ kind: "Capacity", reason: "Payload" });
    fireEvent.click(screen.getByRole("button", { name: "End account" }));
    expect(readPendingReaderPulse(paneId, mediaId)).toBeNull();
    expect(controller.signal.aborted).toBe(true);
    expect(cache.retainReaderSourceInput(input), "account withdrawal released input before physical settlement").toEqual({ kind: "Capacity", reason: "Payload" });
    if (held.finish === null) throw new Error("Source HTTP response was not held");
    held.finish();
    await act(async () => { await retired; });
    const next = cache.retainReaderSourceInput(input);
    expect(next.kind, "settled source input did not return its account capacity").toBe("Acquired");
    if (next.kind === "Acquired") next.lease.release();
  } finally { held.finish?.(); await retired; clearPendingReaderPulse(paneId); view.unmount(); cache.clear(); }
});
