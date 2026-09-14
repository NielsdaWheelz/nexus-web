"use client";

import { useEffect, useRef, useState } from "react";
import { useResource, type AsyncResource } from "@/lib/api/useResource";
import type { PdfReaderResourceState } from "@/components/PdfReader";
import type { DocumentReaderSession, ReaderPdfPaintLease, ReaderViewCapacity } from "@/lib/reader/DocumentReaderSession";

/** The query owner holds its desired page; the leaf retains committed paint through DOM retirement. */
export function useHostedPdfPageHighlights({ sourceKey, session, resourceState, refreshToken, onDefect }: {
  readonly sourceKey: string | null;
  readonly session: DocumentReaderSession;
  readonly resourceState: PdfReaderResourceState;
  readonly refreshToken: number;
  readonly onDefect?: (error: unknown) => void;
}): { readonly resource: AsyncResource<ReaderPdfPaintLease | ReaderViewCapacity>; readonly retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const key = sourceKey !== null && resourceState.numPages > 0 && !resourceState.loading && resourceState.error === null
    ? `${sourceKey}:${resourceState.pageNumber}:${refreshToken}:${attempt}` : null;
  const desired = useRef<{ key: string | null; lease: ReaderPdfPaintLease } | null>(null);
  const result = useResource<ReaderPdfPaintLease | ReaderViewCapacity>({
    cacheKey: key, onDefect,
    load: async (signal) => {
      if (session.pdfHighlights === null) throw new Error("Hosted PDF paint capability is unavailable");
      const result = await session.pdfHighlights({ page_number: resourceState.pageNumber, mine_only: false }, signal);
      if (result.kind === "Capacity") return result;
      if (signal.aborted) { result.lease.release(); signal.throwIfAborted(); }
      desired.current?.lease.release();
      desired.current = { key, lease: result.lease };
      return result.lease;
    },
  });
  useEffect(() => () => {
    const previous = desired.current;
    if (previous?.key !== key) return;
    desired.current = null;
    previous.lease.release();
  }, [key, session]);
  return { resource: result, retry: () => setAttempt((value) => value + 1) };
}
