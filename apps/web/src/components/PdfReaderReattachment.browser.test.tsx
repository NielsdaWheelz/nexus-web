import { useCallback, useMemo } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { page, userEvent } from "vitest/browser";
import { expect, it, vi } from "vitest";
import "pdfjs-dist/web/pdf_viewer.css";
import { createHostedPdfReaderDecorations } from "@/app/(authenticated)/media/[id]/hostedPdfReaderDecorations";
import { MobileViewportProvider } from "@/lib/mobileViewport/MobileViewportProvider";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import { MobileChromeProvider, useMobileChromeVisibleLocks } from "@/lib/workspace/mobileChrome";
import { useReaderScrollPositioner } from "@/lib/reader/paneScroll";
import type { ReaderPublicationDescriptor } from "@/lib/reader/publicationContract";
import PdfReader, { type PdfReaderResources, type PdfReaderVisibleLockReason } from "./PdfReader";
import { pdfReaderSession } from "./__tests__/pdfReaderSession";
import type { DocumentReaderSession } from "@/lib/reader/DocumentReaderSession";
import { onePagePdf } from "./__tests__/pdfFixtures";

const MEDIA = "11111111-1111-4111-8111-111111111111";
const HIGHLIGHT = "22222222-2222-4222-8222-222222222222";
const NO_AUTH_ERROR = () => false;

function Reader({ url, descriptor, session, onAcknowledged }: { onAcknowledged: () => void; session: DocumentReaderSession; url: string; descriptor: Extract<ReaderPublicationDescriptor, { kind: "pdf" }> }) {
  const locks = useMobileChromeVisibleLocks();
  const positioner = useReaderScrollPositioner();
  const acquireLock = useCallback((reason: PdfReaderVisibleLockReason) => locks.acquire(reason), [locks]);
  const resources = useMemo<PdfReaderResources>(() => ({
    signedUrl: { status: "ready", data: { url } },
    pageHighlights: { status: "idle" }, retryPageHighlights: null, requestSignedUrlRefresh: () => {},
  }), [url]);
  const decorations = useMemo(() => createHostedPdfReaderDecorations(descriptor, session), [descriptor, session]);
  return <div style={{ height: 600 }}><PdfReader mediaId={MEDIA} resources={resources} decorations={decorations}
    onHighlightsMutated={onAcknowledged} editingHighlightId={HIGHLIGHT} isMobile={false} mobileChromeEnabled={false}
    acquireMobileChromeVisibleLock={acquireLock} scrollPositioner={positioner} handleAuthenticationError={NO_AUTH_ERROR} /></div>;
}

it("reattaches an unpainted PDF highlight using fresh selected-source geometry and the authoritative returned row", async () => {
  await page.viewport(1280, 800);
  const pdf = onePagePdf("Alpha selected quote Omega");
  const url = URL.createObjectURL(pdf);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await pdf.arrayBuffer()));
  const sha256 = Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
  const descriptor = { kind: "pdf" as const, media_id: MEDIA, reader_generation: 7, title: "Selected old copy",
    reader_contract_version: 1 as const, page_count: 1, document_asset_ref: { key: "assets/document.pdf", bytes: pdf.size, sha256 } };
  const fixture = await pdfReaderSession(descriptor);
  let acknowledgments = 0;
  let holdWrite = false;
  // A returned row naming a page the selected document does not have: the one
  // adoption refusal that survives the write decoder's own source checks.
  let forgedPaintPage: number | null = null;
  const heldResponse: { finish: (() => void) | null } = { finish: null };
  let written: { exact: string; anchor: { reader_generation: number; page_number: number; quads: unknown[] } } | null = null;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const initial = fixture.read(String(input));
    if (initial !== null) return initial;
    if (String(input) !== `/api/highlights/${HIGHLIGHT}` || init?.method !== "PATCH") {
      throw new Error("Reattachment escaped its selected highlight command");
    }
    const body = JSON.parse(String(init.body));
    written = body;
    const response = new Response(JSON.stringify({ data: { id: HIGHLIGHT, color: "yellow", exact: body.exact,
      prefix: "", suffix: "", created_at: "2026-08-01T12:00:00Z", updated_at: "2026-09-13T12:00:00Z",
      author_user_id: MEDIA, is_owner: true, linked_conversations: [], linked_note_blocks: [],
      anchor: { type: "pdf_page_geometry", media_id: MEDIA, source_sha256: sha256,
        page_number: forgedPaintPage ?? body.anchor.page_number, quads: body.anchor.quads } } }), { headers: { "Content-Type": "application/json" } });
    if (holdWrite) return new Promise<Response>((resolve) => { heldResponse.finish = () => resolve(response); });
    return response;
  });
  await fixture.load();
  const view = render(<MobileViewportProvider><MobileChromeProvider><ShareControllerProvider>
    <Reader url={url} descriptor={descriptor} session={fixture.session} onAcknowledged={() => { acknowledgments += 1; }} />
  </ShareControllerProvider></MobileChromeProvider></MobileViewportProvider>);
  try {
    const layer = await screen.findByTestId("pdf-page-text-layer-1");
    const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
    let text: Text | null = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.textContent?.includes("selected quote")) { text = node as Text; break; }
    }
    if (text === null) throw new Error("Real PDF text layer omitted the declared selection");
    const range = document.createRange();
    const start = text.data.indexOf("selected quote");
    range.setStart(text, start); range.setEnd(text, start + "selected quote".length);
    const selection = document.getSelection();
    if (selection === null) throw new Error("Chromium selection is unavailable");
    selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    await screen.findByRole("button", { name: "Highlight" });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Highlight" }), "PDF selection Escape did not dismiss its action surface").not.toBeInTheDocument());
    selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    await userEvent.click(await screen.findByRole("button", { name: "Highlight" }));
    await userEvent.click(await screen.findByRole("button", { name: "Yellow (selected)" }));
    await waitFor(() => expect(written).not.toBeNull());
    expect(written!.anchor.reader_generation).toBe(7);
    expect(written!.exact).toBe("selected quote");
    expect(written!.anchor.page_number).toBe(1);
    expect(written!.anchor.quads.length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.queryAllByTestId(`pdf-highlight-${HIGHLIGHT}-0`),
      "reattached PDF highlight required a previously painted row").toHaveLength(1));
    expect(screen.getByTestId(`pdf-highlight-${HIGHLIGHT}-0`)).toBeVisible();
    expect(acknowledgments).toBe(1);
    // A completed write does not own a later selection in this reader.
    holdWrite = true;
    selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    await userEvent.click(await screen.findByRole("button", { name: "Highlight" }));
    await userEvent.click(await screen.findByRole("button", { name: "Yellow (selected)" }));
    await waitFor(() => expect(heldResponse.finish).not.toBeNull());
    const later = document.createRange(); later.setStart(text, 0); later.setEnd(text, "Alpha".length);
    selection.removeAllRanges(); selection.addRange(later);
    document.dispatchEvent(new Event("selectionchange"));
    heldResponse.finish!(); heldResponse.finish = null;
    await waitFor(() => expect(acknowledgments).toBe(2));
    expect(selection.toString(), "PDF write completion erased a newer same-reader selection").toBe("Alpha");
    // The next real edit also proves that finishing the older write released its gate.
    holdWrite = false;
    await userEvent.click(await screen.findByRole("button", { name: "Highlight" }));
    await userEvent.click(await screen.findByRole("button", { name: "Yellow (selected)" }));
    await waitFor(() => expect(acknowledgments, "preserved PDF selection could not start its own write").toBe(3));
    expect(written!.exact).toBe("Alpha");
    // A committed write whose paint cannot be adopted stays acknowledged and
    // answers in the paint layer's voice, never as a failed text selection.
    forgedPaintPage = 2;
    selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    await userEvent.click(await screen.findByRole("button", { name: "Highlight" }));
    await userEvent.click(await screen.findByRole("button", { name: "Yellow (selected)" }));
    await waitFor(() => expect(acknowledgments,
      "an unpaintable PDF write withheld the acknowledgment the server had already given").toBe(4));
    const saved = await screen.findByText(/^This highlight is saved/);
    expect(saved).toBeVisible();
    expect(saved.getAttribute("data-unpainted-highlight"),
      "the saved-but-unpainted notice did not name its committed write").toBe(HIGHLIGHT);
    expect(screen.queryAllByRole("alert"),
      "a PDF paint failure spoke in the text selection's voice").toHaveLength(0);
    forgedPaintPage = null;
    holdWrite = true;
    selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    await userEvent.click(await screen.findByRole("button", { name: "Highlight" }));
    await userEvent.click(await screen.findByRole("button", { name: "Yellow (selected)" }));
    await waitFor(() => expect(heldResponse.finish).not.toBeNull());
    view.unmount();
    fixture.session.close();
    const { unmount: unmountReplacement } = render(<article aria-label="Replacement reader">A later reader selection</article>);
    try {
      const replacementRange = document.createRange();
      replacementRange.selectNodeContents(screen.getByRole("article", { name: "Replacement reader" }));
      selection.removeAllRanges(); selection.addRange(replacementRange);
      document.dispatchEvent(new Event("selectionchange"));
      heldResponse.finish!();
      await waitFor(() => expect(acknowledgments,
        "retired PDF view discarded an acknowledged bounds edit").toBe(5));
      expect(selection.toString(), "retired PDF acknowledgment erased another reader's selection").toBe("A later reader selection");
    } finally { unmountReplacement(); }
  } finally { heldResponse.finish?.(); view.unmount(); fixture.close(); URL.revokeObjectURL(url); vi.unstubAllGlobals(); }
});
