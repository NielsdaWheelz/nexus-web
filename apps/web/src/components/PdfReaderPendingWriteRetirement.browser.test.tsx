import { useCallback, useMemo } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { cdp, page } from "vitest/browser";
import { expect, it, vi } from "vitest";
import "pdfjs-dist/web/pdf_viewer.css";
import { createHostedPdfReaderDecorations } from "@/app/(authenticated)/media/[id]/hostedPdfReaderDecorations";
import { MobileViewportProvider } from "@/lib/mobileViewport/MobileViewportProvider";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import { MobileChromeProvider, useMobileChromeVisibleLocks } from "@/lib/workspace/mobileChrome";
import { useReaderScrollPositioner } from "@/lib/reader/paneScroll";
import type { ReaderPublicationDescriptor } from "@/lib/reader/publicationContract";
import type { DocumentReaderSession } from "@/lib/reader/DocumentReaderSession";
import type { PdfHighlightOut } from "@/lib/reader/ReaderDecorations";
import PdfReader, { type PdfReaderResources, type PdfReaderVisibleLockReason } from "./PdfReader";
import { pdfReaderSession } from "./__tests__/pdfReaderSession";
import { onePagePdf } from "./__tests__/pdfFixtures";

const MEDIA = "11111111-1111-4111-8111-111111111111";
const HIGHLIGHT = "22222222-2222-4222-8222-222222222222";
const NO_AUTH_ERROR = () => false;

function Reader({ url, descriptor, session, editing, onAcknowledged }: {
  onAcknowledged: (highlight: PdfHighlightOut | null) => void;
  editing: boolean; session: DocumentReaderSession; url: string;
  descriptor: Extract<ReaderPublicationDescriptor, { kind: "pdf" }>;
}) {
  const locks = useMobileChromeVisibleLocks();
  const positioner = useReaderScrollPositioner();
  const acquireLock = useCallback((reason: PdfReaderVisibleLockReason) => locks.acquire(reason), [locks]);
  const resources = useMemo<PdfReaderResources>(() => ({
    signedUrl: { status: "ready", data: { url } },
    pageHighlights: { status: "idle" }, retryPageHighlights: null, requestSignedUrlRefresh: () => {},
  }), [url]);
  const decorations = useMemo(() => createHostedPdfReaderDecorations(descriptor, session), [descriptor, session]);
  return <div style={{ height: 600 }}><PdfReader mediaId={MEDIA} resources={resources} decorations={decorations}
    onHighlightsMutated={onAcknowledged} editingHighlightId={editing ? HIGHLIGHT : null} isMobile={false} mobileChromeEnabled={false}
    acquireMobileChromeVisibleLock={acquireLock} scrollPositioner={positioner} handleAuthenticationError={NO_AUTH_ERROR} /></div>;
}

it.each([false, true])("releases closed PDF source DOM during a pending highlight write (editing: %s)", async (editing) => {
  await page.viewport(1280, 800);
  const pdf = onePagePdf("Alpha selected quote Omega");
  const url = URL.createObjectURL(pdf);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await pdf.arrayBuffer()));
  const sha256 = Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
  const descriptor = { kind: "pdf" as const, media_id: MEDIA, reader_generation: 7, title: "Selected old copy",
    reader_contract_version: 1 as const, page_count: 1, document_asset_ref: { key: "assets/document.pdf", bytes: pdf.size, sha256 } };
  const fixture = await pdfReaderSession(descriptor);
  const acknowledged: Array<{ id: string; exact: string }> = [];
  const pending: { finish: (() => void) | null } = { finish: null };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const initial = fixture.read(String(input));
    if (initial !== null) return initial;
    const expectedPath = editing ? `/api/highlights/${HIGHLIGHT}` : `/api/media/${MEDIA}/pdf-highlights`;
    if (String(input) !== expectedPath || init?.method !== (editing ? "PATCH" : "POST")) {
      throw new Error("PDF write escaped its selected-source command");
    }
    const body = JSON.parse(String(init.body));
    const anchor = editing ? body.anchor : body;
    const response = Response.json({ data: { id: HIGHLIGHT, color: "yellow", exact: body.exact,
      prefix: "", suffix: "", created_at: "2026-08-01T12:00:00Z", updated_at: "2026-09-13T12:00:00Z",
      author_user_id: MEDIA, is_owner: true, linked_conversations: [], linked_note_blocks: [],
      anchor: { type: "pdf_page_geometry", media_id: MEDIA, source_sha256: sha256,
        page_number: anchor.page_number, quads: anchor.quads } } });
    return new Promise<Response>((resolve) => { pending.finish = () => resolve(response); });
  });
  await fixture.load();
  const client = cdp();
  const workers = async () => (await client.send("Target.getTargets")).targetInfos
    .filter((target) => target.type === "worker" && target.url === `${window.location.origin}/pdfjs/pdf.worker.min.mjs`)
    .map((target) => target.targetId);
  const baseline = new Set(await workers());
  const view = render(<MobileViewportProvider><MobileChromeProvider><ShareControllerProvider>
    <Reader url={url} descriptor={descriptor} session={fixture.session} editing={editing}
      onAcknowledged={(highlight) => { if (highlight !== null) acknowledged.push({ id: highlight.id, exact: highlight.exact }); }} />
  </ShareControllerProvider></MobileChromeProvider></MobileViewportProvider>);
  try {
    const retired = await (async () => {
      const layer = await screen.findByTestId("pdf-page-text-layer-1");
      const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
      let text: Text | null = null;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node instanceof Text && node.data.includes("selected quote")) { text = node; break; }
      }
      if (text === null) throw new Error("Real PDF text layer omitted the declared selection");
      const range = document.createRange();
      const start = text.data.indexOf("selected quote");
      range.setStart(text, start); range.setEnd(text, start + "selected quote".length);
      const selection = document.getSelection();
      if (selection === null) throw new Error("Chromium selection is unavailable");
      selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
      // eslint-disable-next-line testing-library/prefer-screen-queries -- justify-eslint-override: selector-backed browser input keeps Vitest completion errors from retaining the retired DOM
      await page.getByRole("button", { name: "Highlight", exact: true }).click();
      // eslint-disable-next-line testing-library/prefer-screen-queries -- justify-eslint-override: selector-backed browser input keeps Vitest completion errors from retaining the retired DOM
      await page.getByRole("button", { name: "Yellow (selected)", exact: true }).click();
      await waitFor(() => expect(pending.finish).not.toBeNull());
      return { text: new WeakRef(text), reader: new WeakRef(screen.getByRole("region", { name: "PDF document" })) };
    })();
    expect(retired.text.deref()?.isConnected).toBe(true);
    expect(retired.reader.deref()?.isConnected).toBe(true);
    const sourceWorkers = (await workers()).filter((id) => !baseline.has(id));
    expect(sourceWorkers, "PDF source did not own a real worker").toHaveLength(1);
    view.unmount(); fixture.session.close();
    await waitFor(async () => expect((await workers()).filter((id) => sourceWorkers.includes(id)),
      "closed PDF source worker has not retired").toHaveLength(0));
    await client.send("HeapProfiler.collectGarbage");
    expect(retired.text.deref(), "pending PDF write retained the retired source text").toBeUndefined();
    expect(retired.reader.deref(), "pending PDF write retained the retired source DOM").toBeUndefined();
    await act(async () => pending.finish!());
    await waitFor(() => expect(acknowledged, "retiring PDF source discarded its acknowledged write")
      .toEqual([{ id: HIGHLIGHT, exact: "selected quote" }]));
  } finally { pending.finish?.(); view.unmount(); fixture.close(); URL.revokeObjectURL(url); vi.unstubAllGlobals(); }
});
