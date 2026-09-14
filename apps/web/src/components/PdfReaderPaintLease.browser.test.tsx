import { useCallback, useMemo } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { page, userEvent } from "vitest/browser";
import { expect, it, vi } from "vitest";
import "pdfjs-dist/web/pdf_viewer.css";
import { createHostedPdfReaderDecorations } from "@/app/(authenticated)/media/[id]/hostedPdfReaderDecorations";
import { ApiError } from "@/lib/api/client";
import { MobileViewportProvider } from "@/lib/mobileViewport/MobileViewportProvider";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import { MobileChromeProvider, useMobileChromeVisibleLocks } from "@/lib/workspace/mobileChrome";
import { useReaderScrollPositioner } from "@/lib/reader/paneScroll";
import PdfReader, { type PdfReaderResources, type PdfReaderVisibleLockReason, type PdfReaderControlActions } from "./PdfReader";
import { onePagePdf } from "./__tests__/pdfFixtures";
import { pdfReaderSession } from "./__tests__/pdfReaderSession";

const MEDIA = "11111111-1111-4111-8111-111111111111";
const HIGHLIGHT = "22222222-2222-4222-8222-222222222222";
const NO_AUTH_ERROR = () => false;

function Reader({ url, fixture, descriptor, pageHighlights, retryPageHighlights, onControlsReady, onReady }: {
  onReady: () => void;
  onControlsReady: (controls: PdfReaderControlActions | null) => void;
  url: string;
  fixture: Awaited<ReturnType<typeof pdfReaderSession>>;
  descriptor: Parameters<typeof pdfReaderSession>[0];
  pageHighlights: PdfReaderResources["pageHighlights"];
  retryPageHighlights: (() => void) | null;
}) {
  const locks = useMobileChromeVisibleLocks();
  const positioner = useReaderScrollPositioner();
  const acquireLock = useCallback((reason: PdfReaderVisibleLockReason) => locks.acquire(reason), [locks]);
  const resources = useMemo<PdfReaderResources>(() => ({
    signedUrl: { status: "ready", data: { url } },
    pageHighlights, retryPageHighlights, requestSignedUrlRefresh: () => {},
  }), [pageHighlights, retryPageHighlights, url]);
  const decorations = useMemo(() => createHostedPdfReaderDecorations(descriptor, fixture.session), [descriptor, fixture]);
  return <div style={{ height: 600 }}><PdfReader mediaId={MEDIA} resources={resources} decorations={decorations}
    onSemanticViewportChange={(value) => { if (value?.intent === "Reader") onReady(); }}
    onControlsReady={onControlsReady} isMobile={false} mobileChromeEnabled={false} acquireMobileChromeVisibleLock={acquireLock}
    scrollPositioner={positioner} handleAuthenticationError={NO_AUTH_ERROR} /></div>;
}

it("keeps published PDF paint charged through actual layer retirement and pending reads through physical settlement", async () => {
  await page.viewport(1280, 800);
  const pdf = onePagePdf("Alpha selected quote Omega");
  const url = URL.createObjectURL(pdf);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await pdf.arrayBuffer()));
  const sha256 = Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
  const descriptor = { kind: "pdf" as const, media_id: MEDIA, reader_generation: 7, title: "Retained source",
    reader_contract_version: 1 as const, page_count: 1, document_asset_ref: { key: "assets/document.pdf", bytes: pdf.size, sha256 } };
  const fixture = await pdfReaderSession(descriptor);
  const paintPage = () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ data: { page_number: 1, source_sha256: sha256,
      highlights: [{ id: HIGHLIGHT, color: "green", created_at: "2026-09-13T00:00:00Z", author_user_id: MEDIA, is_owner: true,
        quads: [{ x1: 70, y1: 60, x2: 230, y2: 60, x3: 230, y3: 80, x4: 70, y4: 80 }] }], next_cursor: null } }));
    return new Response(bytes, { headers: { "Content-Type": "application/json", "Content-Length": String(bytes.byteLength) } });
  };
  let readerReady = false;
  const onReady = () => { readerReady = true; };
  let controls: PdfReaderControlActions | null = null;
  const readControls = (): PdfReaderControlActions | null => controls;
  const onControlsReady = (value: PdfReaderControlActions | null) => { controls = value; };
  const heldResponse: { finish: ((response: Response) => void) | null } = { finish: null };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const path = String(input);
    const initial = fixture.read(path);
    if (initial !== null) return initial;
    if (path.endsWith(`/apparatus/${HIGHLIGHT}/location`)) {
      const bytes = new TextEncoder().encode(JSON.stringify({ data: { kind: "Pdf", page: 1,
        quads: [{ x1: 70, y1: 60, x2: 230, y2: 60, x3: 230, y3: 80, x4: 70, y4: 80 }] } }));
      return new Response(bytes, { headers: { "Content-Type": "application/json", "Content-Length": String(bytes.byteLength) } });
    }
    if (path.endsWith("/reader-publications/7/pdf-highlights")) {
      return new Promise<Response>((resolve) => { heldResponse.finish = resolve; });
    }
    throw new Error(`PDF paint escaped its selected source: ${path}`);
  });
  let view: ReturnType<typeof render> | null = null;
  try {
    await fixture.load();
    // This fixture retains the selected session/descriptor after close; only query charges retire.
    const baseline = fixture.session.residency;
    if (fixture.session.pdfHighlights === null) throw new Error("Hosted PDF paint is unavailable");
    const pending = fixture.session.pdfHighlights({ page_number: 1, mine_only: false }, new AbortController().signal);
    await waitFor(() => expect(heldResponse.finish).not.toBeNull());
    heldResponse.finish!(paintPage());
    const ready = await pending;
    if (ready.kind !== "Acquired") throw new Error("One declared highlight did not fit the experiment profile");
    view = render(<MobileViewportProvider><MobileChromeProvider><ShareControllerProvider>
      <Reader url={url} fixture={fixture} descriptor={descriptor} pageHighlights={{ status: "ready", data: ready.lease }}
        retryPageHighlights={null} onControlsReady={onControlsReady} onReady={onReady} />
    </ShareControllerProvider></MobileChromeProvider></MobileViewportProvider>);
    expect(await screen.findByTestId(`pdf-highlight-${HIGHLIGHT}-0`)).toBeVisible();
    const charged = fixture.session.residency;
    expect(charged.payloadBytes).toBeGreaterThan(0);
    expect(charged.domNodes).toBe(2);
    expect(charged.leases).toBe(1);
    await waitFor(() => expect(readerReady).toBe(true));
    const actions = readControls();
    if (fixture.session.overlays === null || actions === null) throw new Error("Actual PDF source-note controls are unavailable");
    const location = await fixture.session.overlays({ kind: "ApparatusLocation", itemId: HIGHLIGHT }, new AbortController().signal);
    if (location.kind !== "Acquired" || location.lease.result.kind !== "ApparatusLocation" || location.lease.result.page.kind !== "Pdf") {
      throw new Error("Selected PDF source-note location was not admitted");
    }
    expect(fixture.session.residency.domNodes,
      "PDF source-note projection borrowed unreserved DOM").toBe(charged.domNodes + 2);
    expect(fixture.session.residency.payloadBytes).toBeGreaterThan(charged.payloadBytes);
    const position = location.lease.result.page;
    const positioned = actions.locate(position.page, position.quads, new AbortController().signal)
      .finally(() => location.lease.release());
    expect(await screen.findByTestId(/^pdf-highlight-reader-pulse-/)).toBeVisible();
    expect(await positioned).toBe(true);
    expect(screen.queryAllByTestId(/^pdf-highlight-reader-pulse-/)).toHaveLength(0);
    expect(fixture.session.residency).toEqual(charged);
    heldResponse.finish = null;
    const withdrawing = fixture.session.pdfHighlights({ page_number: 1, mine_only: false }, new AbortController().signal);
    const aborted = expect(withdrawing).rejects.toMatchObject({ name: "AbortError" });
    await waitFor(() => expect(heldResponse.finish).not.toBeNull());
    const duringRead = fixture.session.residency;
    fixture.session.close();
    ready.lease.release();
    expect(fixture.session.residency, "session close released a published PDF layer or unfinished physical read").toEqual(duringRead);
    expect(screen.getByTestId(`pdf-highlight-${HIGHLIGHT}-0`)).toBeVisible();
    heldResponse.finish!(paintPage());
    await aborted;
    expect(fixture.session.residency, "late read settlement retired another consumer's PDF paint").toEqual(charged);
    view.unmount(); view = null;
    expect(screen.queryAllByTestId(`pdf-highlight-${HIGHLIGHT}-0`)).toHaveLength(0);
    expect(fixture.session.residency).toEqual(baseline);
    expect(ready.lease.released).toBe(true);
  } finally {
    heldResponse.finish?.(paintPage()); view?.unmount(); fixture.close(); URL.revokeObjectURL(url); vi.unstubAllGlobals();
  }
});

it("contains a failed PDF paint read in the highlight notice with its retry, and retires it while the next read is in flight", async () => {
  await page.viewport(1280, 800);
  const pdf = onePagePdf("Alpha selected quote Omega");
  const url = URL.createObjectURL(pdf);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await pdf.arrayBuffer()));
  const sha256 = Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
  const descriptor = { kind: "pdf" as const, media_id: MEDIA, reader_generation: 7, title: "Retained source",
    reader_contract_version: 1 as const, page_count: 1, document_asset_ref: { key: "assets/document.pdf", bytes: pdf.size, sha256 } };
  const fixture = await pdfReaderSession(descriptor);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const initial = fixture.read(String(input));
    if (initial !== null) return initial;
    throw new Error(`PDF paint escaped its selected source: ${String(input)}`);
  });
  let retries = 0;
  const retry = () => { retries += 1; };
  const noop = () => {};
  const failed: PdfReaderResources["pageHighlights"] = {
    status: "error", error: new ApiError(404, "E_NOT_FOUND", "The reader publication is gone"),
  };
  let view: ReturnType<typeof render> | null = null;
  try {
    await fixture.load();
    const reader = (pageHighlights: PdfReaderResources["pageHighlights"]) => (
      <MobileViewportProvider><MobileChromeProvider><ShareControllerProvider>
        <Reader url={url} fixture={fixture} descriptor={descriptor} pageHighlights={pageHighlights}
          retryPageHighlights={retry} onControlsReady={noop} onReady={noop} />
      </ShareControllerProvider></MobileChromeProvider></MobileViewportProvider>
    );
    view = render(reader(failed));
    // The decoration read failed; the document and its text selection did not.
    expect(await screen.findByTestId("pdf-page-text-layer-1")).toBeVisible();
    expect(await screen.findByText("This PDF is no longer available.")).toBeVisible();
    expect(screen.queryAllByRole("alert"),
      "a failed PDF paint read spoke in the text selection's voice").toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Retry highlights" }));
    expect(retries, "the paint notice offered no live recovery").toBe(1);
    view.rerender(reader({ status: "loading" }));
    await waitFor(() => expect(screen.queryByText("This PDF is no longer available."),
      "a settled paint outcome outlived the read that raised it").not.toBeInTheDocument());
  } finally {
    view?.unmount(); fixture.close(); URL.revokeObjectURL(url); vi.unstubAllGlobals();
  }
});
