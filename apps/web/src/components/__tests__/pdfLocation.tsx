import { useCallback, useMemo, useRef, useState } from "react";
import { screen } from "@testing-library/react";
import type { PdfHighlightQuad } from "@/lib/highlights/pdfTypes";
import { useMobileChromeVisibleLocks } from "@/lib/workspace/mobileChrome";
import { useReaderScrollPositioner } from "@/lib/reader/paneScroll";
import PdfReader, {
  type PdfReaderDecorationWrites,
  type PdfReaderControlActions,
  type PdfReaderResources,
  type PdfReaderVisibleLockReason,
} from "../PdfReader";

export const QUADS = Object.freeze([
  { x1: 70, y1: 600, x2: 230, y2: 600, x3: 230, y3: 620, x4: 70, y4: 620 },
]);
const DECORATIONS: PdfReaderDecorationWrites = {
  adoptHighlightPaint() { throw new Error("this readonly PDF location has no write capability"); },
  createHighlight: async () => {
    throw new Error("this readonly PDF location has no write capability");
  },
  updateHighlight: async () => {
    throw new Error("this readonly PDF location has no write capability");
  },
};
const NO_AUTH_ERROR = () => false;

export function LocationReader({
  url,
  observe,
  quads,
}: {
  url: string;
  observe: (id: number, outcome: string) => void;
  quads: readonly PdfHighlightQuad[];
}) {
  const controls = useRef<PdfReaderControlActions | null>(null);
  const signal = useRef<AbortController | null>(null);
  const next = useRef(0);
  const [outcomes, setOutcomes] = useState<Record<number, string>>({});
  const locks = useMobileChromeVisibleLocks();
  const positioner = useReaderScrollPositioner();
  const [scrollPositioner, setPositioner] = useState(positioner);
  const acquireLock = useCallback(
    (reason: PdfReaderVisibleLockReason) => locks.acquire(reason),
    [locks],
  );
  const onControlsReady = useCallback(
    (actions: PdfReaderControlActions | null) => {
      controls.current = actions;
    },
    [],
  );
  const resources = useMemo<PdfReaderResources>(
    () => ({
      signedUrl: { status: "ready", data: { url } },
      pageHighlights: { status: "idle" },
      retryPageHighlights: null,
      requestSignedUrlRefresh: () => {},
    }),
    [url],
  );
  const locate = (immediateAbort: boolean, targetPage: number, kind: "Geometry" | "Page" = "Geometry") => {
    const actions = controls.current;
    if (!actions) throw new Error("PDF controls unavailable");
    const id = ++next.current;
    const controller = new AbortController();
    signal.current = controller;
    setOutcomes((current) => ({ ...current, [id]: "pending" }));
    const request = kind === "Page" ? actions.locatePage(targetPage, controller.signal) : actions.locate(targetPage, quads, controller.signal);
    void request.then(
      (positioned) => {
        const overlays = screen.queryAllByTestId(
          /^pdf-highlight-reader-pulse-/,
        ).length;
        const outcome = `${positioned}:${overlays}`;
        observe(id, outcome);
        setOutcomes((current) => ({ ...current, [id]: outcome }));
      },
      (error: unknown) => {
        if (!(error instanceof DOMException) || error.name !== "AbortError")
          throw error;
        const overlays = screen.queryAllByTestId(
          /^pdf-highlight-reader-pulse-/,
        ).length;
        setOutcomes((current) => ({ ...current, [id]: `aborted:${overlays}` }));
      },
    );
    if (immediateAbort) controller.abort();
  };
  const [ready, setReady] = useState(false);
  const observeViewport = useCallback(() => setReady(true), []);
  return (
    <>
      <output aria-label="reader ready">{String(ready)}</output>
      <button onClick={() => setPositioner({ run: positioner.run })}>
        replace layout callback
      </button>
      <button onClick={() => locate(false, 1)}>locate target</button>
      <button onClick={() => locate(true, 1)}>locate then abort</button>
      <button onClick={() => locate(false, 2)}>locate unavailable page</button>
      <button onClick={() => signal.current?.abort()}>abort location</button>
      <button onClick={() => locate(false, 1, "Page")}>locate page</button>
      <button onClick={() => locate(true, 1, "Page")}>locate page then abort</button>
      {Object.entries(outcomes).map(([id, value]) => (
        <output key={id} aria-label={`location ${id}`}>
          {value}
        </output>
      ))}
      <div style={{ height: 420, position: "relative" }}>
        <PdfReader
          mediaId="11111111-1111-4111-8111-111111111111"
          resources={resources}
          decorations={DECORATIONS}
          isMobile={false}
          mobileChromeEnabled={false}
          acquireMobileChromeVisibleLock={acquireLock}
          scrollPositioner={scrollPositioner}
          handleAuthenticationError={NO_AUTH_ERROR}
          onControlsReady={onControlsReady}
          onSemanticViewportChange={observeViewport}
        />
      </div>
    </>
  );
}
