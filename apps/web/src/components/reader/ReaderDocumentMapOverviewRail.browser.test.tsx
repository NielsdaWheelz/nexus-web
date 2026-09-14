import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { expect, it, vi } from "vitest";
import "@/app/globals.css";
import { pdfReaderSession } from "../__tests__/pdfReaderSession";
import { onePagePdf } from "../__tests__/pdfFixtures";
import ReaderDocumentMapOverviewRail from "./ReaderDocumentMapOverviewRail";

it("pages selected-source destinations while preserving overview position, keyboard movement and exact retirement", async () => {
  const mediaId = "11111111-1111-4111-8111-111111111111";
  const pdf = onePagePdf("Overview source");
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", await pdf.arrayBuffer()));
  const fixture = await pdfReaderSession({ kind: "pdf", media_id: mediaId, reader_generation: 7, title: "Overview", reader_contract_version: 1,
    page_count: 1, document_asset_ref: { key: "assets/document.pdf", bytes: pdf.size, sha256: Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("") } });
  const emptyCounts = { contents: 0, embeds: 0, highlights: 0, source_references: 0, generated_citations: 0, links: 0, synapses: 0 };
  const response = (data: unknown) => { const bytes = new TextEncoder().encode(JSON.stringify({ data }));
    return new Response(bytes, { headers: { "Content-Type": "application/json", "Content-Length": String(bytes.length) } }); };
  let memberReads = 0;
  let activated = "";
  const heldActivation: { finish: (() => void) | null } = { finish: null };
  const read = fixture.read;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input); const selected = read(path); if (selected !== null) return selected;
    const body = JSON.parse(String(init?.body));
    const prefix = `/api/media/${mediaId}/reader-publications/7/evidence/overview`;
    if (path === prefix) return response({ bucket_count: body.bucket_count, buckets: [
      { index: 2, counts: { ...emptyCounts, highlights: 1, source_references: 1 } },
      { index: body.bucket_count - 2, counts: { ...emptyCounts, links: 1 } },
    ], unavailable_counts: { ...emptyCounts, source_references: 1 } });
    if (path === `${prefix}/preview`) {
      const kind = String(body.marker_id).split(":")[1];
      const label = kind === "Highlight" ? "Opening claim" : "Primary source";
      return response({ marker_id: body.marker_id, kind, tone: kind === "Highlight" ? "Highlight" : "Citation",
        label_excerpt: label, label_codepoints: label.length, excerpt: null, excerpt_codepoints: null });
    }
    if (path === `${prefix}/bucket`) {
      memberReads += 1;
      const kind = body.after === null ? "Highlight" : "SourceReference";
      const itemId = body.after === null ? "highlight:early" : "apparatus:early";
      return response({ items: [{ id: `marker:${kind}:${itemId}`, kind, item_id: itemId,
        position: (body.index + 0.5) / body.bucket_count, target: { kind: "Fact", fact_id: itemId } }], next_cursor: body.after === null ? "next-source" : null });
    }
    throw new Error(`Overview escaped the selected generation: ${path}`);
  });
  await fixture.load();
  const baseline = fixture.session.residency;
  const view = render(<div style={{ height: 400, display: "flex", justifyContent: "flex-end" }}><ReaderDocumentMapOverviewRail marginFilters={{ highlight: true, citation: true, link: true, synapse: true }} onHasMarginFacts={() => {}} session={fixture.session} refreshToken={0}
    visibleRange={{ start: 0.25, end: 0.5 }} resourceId={mediaId}
    onActivateMarker={async (marker) => { activated = marker.item_id; await new Promise<void>((resolve) => { heldActivation.finish = resolve; }); return { kind: "Located" }; }}
    onDefect={(defect) => { if (defect !== null) throw defect.error; }} /></div>);
  try {
    const cluster = await screen.findByRole("button", { name: /^2 destinations near \d+% through document$/ });
    // A bucket holding one destination names that destination, not its arity.
    const late = screen.getByRole("button", { name: /^Link near \d+% through document$/ });
    expect(screen.getByText("1 destination has no source position.")).toBeVisible();
    const track = screen.getByRole("toolbar", { name: "Document Map destinations" });
    const band = screen.getByTestId("reader-document-map-band");
    const trackRect = track.getBoundingClientRect(); const bandRect = band.getBoundingClientRect();
    expect((bandRect.top - trackRect.top) / trackRect.height).toBeCloseTo(0.25);
    expect(bandRect.height / trackRect.height).toBeCloseTo(0.25);
    expect(memberReads, "overview drained destination pages before disclosure").toBe(0);
    cluster.focus(); await userEvent.keyboard("{ArrowDown}"); expect(late).toHaveFocus();
    await userEvent.click(cluster);
    const destinations = await screen.findByRole("list", { name: "Destinations in this part" });
    expect(cluster.getAttribute("aria-controls"), "the opened bucket button does not own its destination list").toBe(destinations.id);
    const highlight = await within(destinations).findByRole("button", { name: /^Highlight,/ });
    expect(highlight).toHaveFocus();
    expect(await within(screen.getByRole("tooltip")).findByText("Opening claim")).toBeVisible();
    await userEvent.keyboard("{Escape}"); await waitFor(() => expect(cluster).toHaveFocus());
    expect(screen.queryByRole("list", { name: "Destinations in this part" })).not.toBeInTheDocument();
    await userEvent.click(cluster); await screen.findByRole("button", { name: /^Highlight,/ });
    await userEvent.click(screen.getByRole("button", { name: "Next destinations" }));
    const citation = await screen.findByRole("button", { name: /^Citation,/ });
    expect(screen.queryByRole("button", { name: /^Highlight,/ })).not.toBeInTheDocument();
    expect(await within(screen.getByRole("tooltip")).findByText("Primary source")).toBeVisible();
    await userEvent.click(citation);
    expect(activated).toBe("apparatus:early");
    await waitFor(() => expect(heldActivation.finish).not.toBeNull());
    const published = fixture.session.residency;
    view.unmount();
    expect(fixture.session.residency.payloadBytes, "retired overview released a pending destination consumer").toBeGreaterThan(baseline.payloadBytes);
    expect(fixture.session.residency.payloadBytes).toBeLessThan(published.payloadBytes);
    heldActivation.finish!();
    await waitFor(() => expect(fixture.session.residency, "retired overview retained source pages or DOM charges").toEqual(baseline));
  } finally { heldActivation.finish?.(); view.unmount(); fixture.close(); vi.unstubAllGlobals(); }
});
