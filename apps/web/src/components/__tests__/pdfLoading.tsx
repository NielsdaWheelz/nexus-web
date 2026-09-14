import { useCallback } from "react";
import { useMobileChromeVisibleLocks } from "@/lib/workspace/mobileChrome";
import { useReaderScrollPositioner } from "@/lib/reader/paneScroll";
import type { PdfFindRuntime } from "../pdfPaneFind";
import PdfReader, { type PdfReaderControlActions, type PdfReaderResources, type PdfReaderVisibleLockReason } from "../PdfReader";

const unsupported = async () => { throw new Error("Readonly loading experiment cannot write highlights"); };
const decorations = { createHighlight: unsupported, updateHighlight: unsupported,
  adoptHighlightPaint: () => { throw new Error("Readonly loading experiment cannot adopt a write"); } };

export function PdfLoadingReader({ resources, observe }: { resources: PdfReaderResources; observe: { controls: PdfReaderControlActions | null; find: PdfFindRuntime | null } }) {
  const locks = useMobileChromeVisibleLocks();
  const acquire = useCallback((reason: PdfReaderVisibleLockReason) => locks.acquire(reason), [locks]);
  const controls = useCallback((value: PdfReaderControlActions | null) => { observe.controls = value; }, [observe]);
  const find = useCallback((value: PdfFindRuntime | null) => { observe.find = value; }, [observe]);
  return <div style={{ height: 420, position: "relative" }}><PdfReader mediaId="11111111-1111-4111-8111-111111111111"
    resources={resources} decorations={decorations} isMobile={false} mobileChromeEnabled={false}
    acquireMobileChromeVisibleLock={acquire} scrollPositioner={useReaderScrollPositioner()} handleAuthenticationError={() => false}
    onControlsReady={controls} onFindRuntimeReady={find} /></div>;
}
