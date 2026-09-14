import { pdfReaderSession } from "./__tests__/pdfReaderSession";
import type { DocumentReaderSession } from "@/lib/reader/DocumentReaderSession";
import { onePagePdf } from "./__tests__/pdfFixtures";
import { useCallback, useMemo, useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { page, userEvent } from "vitest/browser";
import { expect, it, vi } from "vitest";
import "pdfjs-dist/web/pdf_viewer.css";
import { MobileViewportProvider } from "@/lib/mobileViewport/MobileViewportProvider";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import {
  MobileChromeProvider,
  useMobileChromeReaderScrollport,
  useMobileChromeVisibleLocks,
} from "@/lib/workspace/mobileChrome";
import { createHostedPdfReaderDecorations } from "@/app/(authenticated)/media/[id]/hostedPdfReaderDecorations";
import { useHostedPdfPageHighlights } from "@/app/(authenticated)/media/[id]/useHostedPdfPageHighlights";
import { useReaderScrollPositioner } from "@/lib/reader/paneScroll";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import type { PdfHighlightOut } from "@/lib/reader/ReaderDecorations";
import type { ReaderPublicationDescriptor } from "@/lib/reader/publicationContract";
import PdfReader, {
  type PdfReaderResourceState,
  type PdfReaderVisibleLockReason,
} from "./PdfReader";

const MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const EXACT = "selected quote";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function json(data: unknown): Response {
  const body = JSON.stringify({ data });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "application/json", "Content-Length": String(new TextEncoder().encode(body).byteLength) },
  });
}

function committedHighlight(sourceSha256: string): PdfHighlightOut {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    anchor: {
      type: "pdf_page_geometry",
      media_id: MEDIA_ID,
      source_sha256: sourceSha256,
      page_number: 1,
      quads: [
        {
          x1: 70,
          y1: 60,
          x2: 230,
          y2: 60,
          x3: 230,
          y3: 80,
          x4: 70,
          y4: 80,
        },
      ],
    },
    color: "green",
    exact: EXACT,
    prefix: "Alpha ",
    suffix: " Omega",
    created_at: "2026-08-01T12:00:00.000Z",
    updated_at: "2026-08-01T12:00:00.000Z",
    author_user_id: "22222222-2222-4222-8222-222222222222",
    is_owner: true,
    linked_conversations: [],
    linked_note_blocks: [],
  };
}

function installPdfBff(sourceSha256: string, fixture: Awaited<ReturnType<typeof pdfReaderSession>>) {
  const reconciliationStarted = deferred<void>();
  const reconciliation = deferred<Response>();
  let highlightMutated = false;
  let highlightWrite: {
    exact: string;
    page_number: number;
    quads: unknown[];
  } | null = null;

  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(
        request?.url ?? String(input),
        window.location.origin,
      );
      const method = (init?.method ?? request?.method ?? "GET").toUpperCase();

      const initial = fixture.read(url.pathname);
      if (initial !== null) return initial;
      if (
        url.pathname === `/api/media/${MEDIA_ID}/reader-publications/7/pdf-highlights` &&
        method === "POST"
      ) {
        // Reads before the committed mutation are empty; the read AFTER the
        // mutation is the reconciliation read the proof holds pending.
        if (!highlightMutated) {
          return json({ page_number: 1, source_sha256: sourceSha256, highlights: [], next_cursor: null });
        }
        reconciliationStarted.resolve();
        return reconciliation.promise;
      }
      if (
        url.pathname === `/api/media/${MEDIA_ID}/pdf-highlights` &&
        method === "POST"
      ) {
        const body = request
          ? await request.clone().json()
          : JSON.parse(String(init?.body));
        highlightWrite = body as typeof highlightWrite;
        highlightMutated = true;
        return json(committedHighlight(sourceSha256));
      }
      throw new Error(
        `Unexpected PDF BFF request: ${method} ${url.pathname}${url.search}`,
      );
    },
  );

  return {
    reconciliationStarted: reconciliationStarted.promise,
    readHighlightWrite: () => highlightWrite,
    finishReconciliation() {
      reconciliation.resolve(json({ page_number: 1, source_sha256: sourceSha256, highlights: [], next_cursor: null }));
    },
  };
}

function textNodeContaining(root: HTMLElement, value: string): Text {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent?.includes(value)) {
      return node as Text;
    }
  }
  throw new Error(`Rendered PDF text layer omitted ${JSON.stringify(value)}.`);
}

// The actual leaf receives the selected PDF bytes; hosted query/write owners
// still cross the BFF and reconcile committed highlights against PDF.js geometry.
function PdfReaderHarness({ pdfUrl, descriptor, session }: { session: DocumentReaderSession; pdfUrl: string; descriptor: Extract<ReaderPublicationDescriptor, { kind: "pdf" }> }) {
  const [highlightRefresh, setHighlightRefresh] = useState(0);
  const [resourceState, setResourceState] = useState<PdfReaderResourceState>({
    pageNumber: 1,
    numPages: 0,
    loading: true,
    error: null,
  });
  const decorations = useMemo(
    () => createHostedPdfReaderDecorations(descriptor, session),
    [descriptor, session],
  );
  const signedUrl = useMemo(
    () => ({
      status: "ready" as const,
      data: { url: pdfUrl },
    }),
    [pdfUrl],
  );
  const pageHighlights = useHostedPdfPageHighlights({
    sourceKey: JSON.stringify([descriptor.media_id, descriptor.reader_generation, descriptor.document_asset_ref.sha256]),
    session,
    resourceState,
    refreshToken: highlightRefresh,
  });
  // Same publish guard as MediaPaneBody's handlePdfResourceStateChange: only
  // adopt a genuinely different resource state.
  const handleResourceStateChange = useCallback(
    (nextState: PdfReaderResourceState) => {
      setResourceState((current) =>
        current.pageNumber === nextState.pageNumber &&
        current.numPages === nextState.numPages &&
        current.loading === nextState.loading &&
        current.error === nextState.error
          ? current
          : nextState,
      );
    },
    [],
  );
  const isMobile = useIsMobileViewport();
  const locks = useMobileChromeVisibleLocks();
  const scrollPositioner = useReaderScrollPositioner();
  const additionalViewportRef = useMobileChromeReaderScrollport<HTMLDivElement>(
    {
      sourceKey: MEDIA_ID,
      enabled: false,
    },
  );
  const acquireMobileChromeVisibleLock = useCallback(
    (reason: PdfReaderVisibleLockReason) => locks.acquire(reason),
    [locks],
  );
  // Production (MediaPaneBody) passes identity-stable handlers; an unstable
  // handler would re-run PdfReader's document bootstrap on every host render.
  const handleAuthenticationError = useCallback(() => false, []);
  const requestSignedUrlRefresh = useCallback(() => undefined, []);
  const handleHighlightsMutated = useCallback(
    () => setHighlightRefresh((value) => value + 1),
    [],
  );
  return (
    <PdfReader
      mediaId={MEDIA_ID}
      resources={{
        signedUrl,
        pageHighlights: pageHighlights.resource,
        retryPageHighlights: pageHighlights.retry,
        requestSignedUrlRefresh,
      }}
      decorations={decorations}
      onHighlightsMutated={handleHighlightsMutated}
      onResourceStateChange={handleResourceStateChange}
      isMobile={isMobile}
      mobileChromeEnabled={false}
      additionalViewportRef={additionalViewportRef}
      acquireMobileChromeVisibleLock={acquireMobileChromeVisibleLock}
      scrollPositioner={scrollPositioner}
      handleAuthenticationError={handleAuthenticationError}
    />
  );
}

it("keeps a committed PDF highlight visible while BFF reconciliation is pending", async () => {
  await page.viewport(1_280, 800);
  const pdf = onePagePdf(`Alpha ${EXACT} Omega`);
  const pdfUrl = URL.createObjectURL(pdf);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", await pdf.arrayBuffer()));
  const sha256 = Array.from(hash, (value) => value.toString(16).padStart(2, "0")).join("");
  const descriptor = { kind: "pdf" as const, media_id: MEDIA_ID, reader_generation: 7, title: "Selected PDF",
    reader_contract_version: 1 as const, page_count: 1, document_asset_ref: { key: "assets/document.pdf", bytes: pdf.size, sha256 } };
  const fixture = await pdfReaderSession(descriptor);
  const bff = installPdfBff(sha256, fixture);
  await fixture.load();
  let foreignTextLayer: HTMLDivElement | null = null;

  try {
    const view = render(
      <MobileViewportProvider>
        <MobileChromeProvider>
          <ShareControllerProvider>
            <PdfReaderHarness pdfUrl={pdfUrl} descriptor={descriptor} session={fixture.session} />
          </ShareControllerProvider>
        </MobileChromeProvider>
      </MobileViewportProvider>,
    );

    const textLayer = await screen.findByTestId(
      "pdf-page-text-layer-1",
      {},
      { timeout: 10_000 },
    );
    const textNode = textNodeContaining(textLayer, EXACT);
    const start = textNode.data.indexOf(EXACT);
    const range = document.createRange();
    range.setStart(textNode, start);
    range.setEnd(textNode, start + EXACT.length);
    const selection = window.getSelection();
    if (!selection) {
      throw new Error("Chromium did not expose the document Selection.");
    }
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));

    await screen.findByRole("button", {
      name: "Highlight",
    });

    foreignTextLayer = document.createElement("div");
    foreignTextLayer.className = "textLayer";
    foreignTextLayer.textContent = "foreign reader quote";
    document.body.append(foreignTextLayer);
    const foreignRange = document.createRange();
    foreignRange.selectNodeContents(foreignTextLayer);
    selection.removeAllRanges();
    selection.addRange(foreignRange);
    document.dispatchEvent(new Event("selectionchange"));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Highlight" })).toBeNull();
    });
    expect(selection.toString()).toBe("foreign reader quote");
    foreignTextLayer.remove();
    foreignTextLayer = null;

    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    const highlightButton = await screen.findByRole("button", {
      name: "Highlight",
    });
    await page.viewport(1_120, 720);
    expect(highlightButton).toBeVisible();

    await userEvent.click(highlightButton);
    await userEvent.click(await screen.findByRole("button", { name: "Green" }));
    await bff.reconciliationStarted;

    const highlightWrite = bff.readHighlightWrite();
    expect(highlightWrite).not.toBeNull();
    expect(highlightWrite?.exact).toBe(EXACT);
    expect(highlightWrite?.page_number).toBe(1);
    expect(highlightWrite?.quads.length).toBeGreaterThan(0);

    const committedOverlay = screen.queryByTestId(
      "pdf-highlight-33333333-3333-4333-8333-333333333333-0",
    );
    expect(
      committedOverlay,
      "Committed PDF highlight disappeared before BFF reconciliation completed.",
    ).not.toBeNull();
    expect(committedOverlay!).toBeVisible();
    view.unmount();
  } finally {
    foreignTextLayer?.remove();
    bff.finishReconciliation();
    fixture.close();
    URL.revokeObjectURL(pdfUrl);
  }
});
