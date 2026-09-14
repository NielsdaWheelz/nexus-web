import { useState } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import ReaderContentBoundary from "@/components/reader/ReaderContentBoundary";
import { PaneRouteErrorBoundary } from "@/components/workspace/PaneRouteErrorBoundary";
import { useHostedTextHighlights, type TextHighlightDefect } from "./useHostedTextHighlights";

const HIGHLIGHT = "11111111-1111-4111-8111-111111111111";
const originalSendBeacon = navigator.sendBeacon;
afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: originalSendBeacon });
});

function Reader() {
  const [fragmentId, setFragmentId] = useState<string | null>("fragment");
  const [draft, setDraft] = useState("");
  const [defect, setDefect] = useState<TextHighlightDefect | null>(null);
  const detail = useHostedTextHighlights({ mediaId: "media", source: { kind: "Detail", fragmentId, highlightId: HIGHLIGHT }, onDefect: setDefect });
  return <section aria-label="Reader">
    <input aria-label="Note draft" value={draft} onChange={(event) => setDraft(event.target.value)} />
    <ReaderContentBoundary ready defect={defect} retry={detail.retry}>
      <p>Retained source text</p>
      <section aria-label="Painted highlights">{detail.highlights.map((highlight) => <p key={highlight.id}>{highlight.exact}</p>)}</section>
      <section aria-label="Selected highlight">{detail.selectedHighlight?.exact}</section>
      <button type="button" onClick={() => setFragmentId(null)}>Retire source unit</button>
      <button type="button" onClick={() => setFragmentId("other-fragment")}>Open another source unit</button>
    </ReaderContentBoundary>
  </section>;
}

it("contains selected-detail defects below the draft owner and retries the exact detail", async () => {
  let fail: (() => void) | null = null;
  let failed = false;
  let requests = 0;
  Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: () => true });
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    if (String(input) !== `/api/highlights/${HIGHLIGHT}`) throw new Error("Selected-detail retry broadened its read");
    requests += 1;
    if (!failed) return new Promise<Response>((resolve) => { fail = () => { failed = true; resolve(Response.json({ data: { id: HIGHLIGHT } })); }; });
    return Promise.resolve(Response.json({ data: {
      id: HIGHLIGHT, anchor: { type: "fragment_offsets", media_id: "media", fragment_id: "fragment", start_offset: 0, end_offset: 4 },
      color: "yellow", exact: "Reta", prefix: "", suffix: "", author_user_id: "reader", is_owner: true,
      created_at: "2026-09-13T00:00:00Z", updated_at: "2026-09-13T00:00:00Z", linked_conversations: [], linked_note_blocks: [],
    } }));
  });
  const view = render(<>
    <PaneRouteErrorBoundary paneId="reader" visitId="reader" resetKey="reader" slotMinWidth="0" isActive={false}><Reader /></PaneRouteErrorBoundary>
    <section aria-label="Other reader"><p>Other source</p></section>
  </>);
  try {
    const draft = screen.getByRole("textbox", { name: "Note draft" });
    const other = within(screen.getByRole("region", { name: "Other reader" })).getByText("Other source");
    await userEvent.fill(draft, "unfinished private note");
    await waitFor(() => expect(fail).not.toBeNull());
    fail!();
    await waitFor(() => expect(screen.queryAllByText(/^(The reader couldn’t load this part\.|This pane couldn’t load)$/)).toHaveLength(1));
    expect(draft.isConnected, "selected-detail defect discarded the draft owner").toBe(true);
    expect(screen.getByText("The reader couldn’t load this part.")).toBeVisible();
    expect(draft).toBeVisible();
    expect(draft).toHaveValue("unfinished private note");
    expect(screen.getByText("Retained source text")).toBeVisible();
    expect(screen.getByText("Other source")).toBe(other);
    await userEvent.click(screen.getByRole("button", { name: "Retry reader" }));
    await waitFor(() => expect(screen.getByRole("region", { name: "Selected highlight" })).toHaveTextContent("Reta"));
    expect(screen.getByRole("region", { name: "Painted highlights" })).toHaveTextContent("Reta");
    const detailRequests = requests;
    await userEvent.click(screen.getByRole("button", { name: "Retire source unit" }));
    await userEvent.click(screen.getByRole("button", { name: "Open another source unit" }));
    expect(screen.getByRole("region", { name: "Selected highlight" }), "unloaded source discarded addressed highlight detail").toHaveTextContent("Reta");
    expect(screen.getByRole("region", { name: "Painted highlights" }), "addressed detail painted another fragment").toBeEmptyDOMElement();
    expect(requests, "viewport membership reloaded addressed detail").toBe(detailRequests);
    expect(draft).toHaveValue("unfinished private note");
  } finally { view.unmount(); }
});
