import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { expect, it, vi } from "vitest";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import HighlightNoteEditor from "@/components/notes/HighlightNoteEditor";
import { saveHighlightNote } from "@/lib/highlights/api";
import { useEvidenceFilters } from "@/lib/reader/useEvidenceFilters";
import { pdfReaderSession } from "../../__tests__/pdfReaderSession";
import { onePagePdf } from "../../__tests__/pdfFixtures";
import PublicationEvidence, { type PublicationEvidenceSelection } from "./PublicationEvidence";

it("pages exact source evidence while retaining an independent highlight draft and retiring obsolete page consumers", async () => {
  const mediaId = "11111111-1111-4111-8111-111111111111";
  const highlightId = "22222222-2222-4222-8222-222222222222";
  const nextHighlightId = "33333333-3333-4333-8333-333333333333";
  const noteId = "44444444-4444-4444-8444-444444444444";
  const pdf = onePagePdf("Bounded evidence source");
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", await pdf.arrayBuffer()));
  const fixture = await pdfReaderSession({ kind: "pdf", media_id: mediaId, reader_generation: 7, title: "Retained evidence", reader_contract_version: 1,
    page_count: 1, document_asset_ref: { key: "assets/document.pdf", bytes: pdf.size, sha256: Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("") } });
  const fact = (id: string, label: string) => ({ kind: "Highlight", id: `highlight:${id}`, locus_ref: `highlight:${id}`,
    label_excerpt: label, label_codepoints: label.length, excerpt: null, excerpt_codepoints: null,
    position: { kind: "Pdf", page: 1 }, association_count: 1, also_reference_count: 0,
    highlight_id: id, color: "yellow", created_at: "2026-09-13T12:00:00Z", updated_at: "2026-09-13T12:00:00Z", author_user_id: mediaId, is_owner: true });
  const counts = { highlights: 2, citations: 0, links: 0, synapses: 0, passages: 2, document: 0 };
  const first = { items: [fact(highlightId, "First retained passage")], counts, next_cursor: "after-first" };
  const second = { items: [fact(nextHighlightId, "Later retained passage")], counts, next_cursor: null };
  const response = (data: unknown) => {
    const bytes = new TextEncoder().encode(JSON.stringify({ data }));
    return new Response(bytes, { headers: { "Content-Type": "application/json", "Content-Length": String(bytes.length) } });
  };
  let holdNext = false;
  const heldResponse: { finish: (() => void) | null } = { finish: null };
  let onOpened = "";
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const initial = fixture.read(path);
    if (initial !== null) return initial;
    const body = JSON.parse(String(init?.body));
    if (path === `/api/highlights/${highlightId}/note`) return response({ note_block_id: body.note_block_id,
      body_pm_json: body.body_pm_json, body_text: "A draft survives pagination" });
    requests.push({ path, body });
    const prefix = `/api/media/${mediaId}/reader-publications/7/evidence`;
    if (path === prefix) {
      if (body.scope === "Document" || !(body.kinds as string[]).includes("Highlight")) return response({ items: [], counts, next_cursor: null });
      if (body.after === "after-first") return holdNext ? new Promise<Response>((resolve) => { heldResponse.finish = () => resolve(response(second)); }) : response(second);
      return response(first);
    }
    if (path === `${prefix}/seek`) return response(!(body.kinds as string[]).includes("Highlight") ? { items: [], counts, next_cursor: null } : (body.target as { fact_id: string }).fact_id === first.items[0].id ? first : second);
    if (path === `${prefix}/associations`) return response({ items: [{ relationship: "AuthoredIn", object: {
      kind: "Note", ref: `note_block:${noteId}`, note_block_id: noteId, label_excerpt: "Linked note", label_codepoints: 11,
      excerpt: "Independent note excerpt", excerpt_codepoints: 24,
      activation: { kind: "route", resource_ref: `note_block:${noteId}`, href: `/notes/${noteId}`, unresolved_reason: null },
    } }], next_cursor: null });
    throw new Error(`Evidence escaped the selected publication: ${path}`);
  });
  await fixture.load();
  const baseline = fixture.session.residency;
  function Reader() {
    const filters = useEvidenceFilters();
    const [selected, setSelected] = useState<PublicationEvidenceSelection | null>(null);
    const [follow, setFollow] = useState(0);
    return <FeedbackProvider><button type="button" onClick={() => setFollow((value) => value + 1)}>Focus later passage</button>
      <PublicationEvidence session={fixture.session} filters={filters} refreshToken={0} activeSourceKey={null} activeItemId={follow === 0 ? null : second.items[0].id} followGeneration={follow}
        selectedDetail={selected?.kind === "Highlight" ? <HighlightNoteEditor highlightId={selected.highlightId} note={null} editable
          onSave={saveHighlightNote} onDelete={async () => { throw new Error("This proof does not delete a note"); }} onOpenLink={() => {}} /> : null}
        onSelect={setSelected} onActivateObject={(object) => { onOpened = object.ref; }}
        onLocate={async () => ({ kind: "Unavailable" })} onHover={() => {}}
        onRemoveEdge={async () => { throw new Error("This proof does not mutate an edge"); }} onDismissSynapse={async () => { throw new Error("This proof does not dismiss a suggestion"); }} onDefect={(defect) => { if (defect !== null) throw defect.error; }} />
    </FeedbackProvider>;
  }
  const view = render(<Reader />);
  try {
    expect(await screen.findByText("First retained passage")).toBeVisible();
    expect(screen.getByRole("button", { name: "Highlights (2)" })).toBeVisible();
    expect(requests).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Highlight details" }));
    const editor = await screen.findByRole("textbox", { name: "Highlight note" });
    await userEvent.fill(editor, "A draft survives pagination");
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText("Later retained passage")).toBeVisible();
    expect(screen.queryByText("First retained passage")).not.toBeInTheDocument();
    expect(editor, "evidence pagination retired the selected highlight draft").toHaveTextContent("A draft survives pagination");
    await userEvent.click(screen.getByRole("button", { name: "Relationships (1)" }));
    expect(await screen.findByText("Independent note excerpt")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Open note" }));
    expect(onOpened).toBe(`note_block:${noteId}`);
    await userEvent.click(screen.getByRole("button", { name: "Back to evidence" }));
    await screen.findByText("First retained passage");
    holdNext = true;
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(heldResponse.finish).not.toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "Document (0)" }));
    await screen.findByText("No evidence matches this scope and these filters.");
    heldResponse.finish!();
    await waitFor(() => expect(fixture.session.residency.leases).toBe(1));
    expect(screen.queryByText("Later retained passage"), "obsolete evidence page republished after a scope change").not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Focus later passage" }));
    expect(await screen.findByText("Later retained passage")).toBeVisible();
    expect(requests.at(-1)?.path).toContain("/evidence/seek");
    await userEvent.click(screen.getByRole("button", { name: "Highlights (2)" }));
    await screen.findByText("No evidence matches this scope and these filters.");
    expect(requests.at(-1)?.body.after).toBeNull();
    expect(editor).toHaveTextContent("A draft survives pagination");
    view.unmount();
    expect(fixture.session.residency, "retired evidence page retained its DOM or source payload").toEqual(baseline);
  } finally { heldResponse.finish?.(); view.unmount(); fixture.close(); vi.unstubAllGlobals(); }
});
