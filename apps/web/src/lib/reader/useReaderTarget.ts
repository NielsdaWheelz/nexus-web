"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePaneRouter, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { passageAnchorIdFromHash, usePassageResolution } from "./passageResolution";
import {
  consumePendingReaderPulse,
  useReaderPulseHighlight,
  type ReaderPulseTarget,
} from "./pulseEvent";
import {
  parseReaderTargetHash,
  type ReaderTarget,
} from "./readerTargetHash";

export interface ReaderTargetState {
  target: ReaderTarget | null;
  status: "idle" | "pending" | "active" | "dismissed";
  setTarget: (target: ReaderTarget) => void;
  markActive: (expectedTarget: ReaderTarget) => void;
  clearTarget: () => void;
  passageResolution: ReturnType<typeof usePassageResolution>;
}

function targetFromPulse(detail: ReaderPulseTarget): ReaderTarget | null {
  if (detail.focusBehavior === "preserve_position") return null;
  if (detail.evidenceSpanId) {
    return { kind: "evidence", value: detail.evidenceSpanId, origin: "pulse" };
  }
  if (detail.highlightId) {
    return { kind: "highlight", value: detail.highlightId, origin: "pulse" };
  }
  const loc = detail.locator;
  if (loc.type === "web_text_offsets" || loc.type === "epub_fragment_offsets") {
    return { kind: "text", value: `${loc.fragment_id}:${loc.start_offset}:${loc.end_offset}`, origin: "pulse" };
  }
  if (loc.type === "pdf_page_geometry") {
    return { kind: "page", value: String(loc.page_number), origin: "pulse" };
  }
  if (loc.type === "transcript_time_range") {
    return { kind: "t", value: String(loc.t_start_ms), origin: "pulse" };
  }
  return null;
}

function hashFromPaneHref(href: string | null): string {
  if (!href) return "";
  try {
    return new URL(href, window.location.origin).hash;
  } catch {
    return "";
  }
}

export function useReaderTarget(mediaId: string): ReaderTargetState {
  const router = usePaneRouter();
  const paneRuntime = usePaneRuntime();
  const paneHref = paneRuntime?.href ?? null;
  const hasPaneRuntime = paneRuntime !== null;
  const paneHash = typeof window === "undefined"
    ? ""
    : hasPaneRuntime
      ? hashFromPaneHref(paneHref)
      : window.location.hash;
  const passageResolution = usePassageResolution({
    hash: paneHash,
    ownerScheme: "media",
    ownerId: mediaId,
  });
  const [state, setState] = useState<{
    target: ReaderTarget | null;
    status: ReaderTargetState["status"];
  }>(() => ({ target: null, status: "idle" }));
  const stateRef = useRef(state);
  const mediaIdRef = useRef(mediaId);
  const hashRef = useRef<string | null>(null);
  stateRef.current = state;
  const publish = useCallback((next: typeof state) => {
    if (stateRef.current.target === next.target && stateRef.current.status === next.status) return;
    stateRef.current = next;
    setState(next);
  }, []);
  const resolvedPassage = passageResolution.status === "ready" ? passageResolution.data : null;

  useEffect(() => {
    const mediaChanged = mediaIdRef.current !== mediaId;
    mediaIdRef.current = mediaId;
    const hash = paneHash;
    const hashChanged = hashRef.current !== hash;
    hashRef.current = hash;
    const publishPending = (next: ReaderTarget) => {
      const current = stateRef.current;
      if (!mediaChanged && !hashChanged &&
          current.target?.kind === next.kind && current.target.value === next.value &&
          current.target.origin === next.origin &&
          (current.status === "pending" || current.status === "active")) return;
      publish({ target: next, status: "pending" });
    };
    const parsed = parseReaderTargetHash(hash);
    if (parsed) {
      publishPending({ ...parsed, origin: "hash" });
      return;
    }
    if (passageAnchorIdFromHash(hash)) {
      if (resolvedPassage?.kind === "Present") {
        const passage = resolvedPassage.value;
        if (passage.kind === "FragmentTextOffsets") {
          publishPending({ kind: "text", value: `${passage.fragmentId}:${passage.startOffset}:${passage.endOffset}`, origin: "passage" });
        } else if (passage.kind === "TimeRange") {
          publishPending({ kind: "t", value: String(passage.startMs), origin: "passage" });
        } else if (passage.kind === "PdfPage") {
          publishPending({ kind: "page", value: String(passage.pageNumber), origin: "passage" });
        }
      } else {
        publish({ target: null, status: "idle" });
      }
      return;
    }
    if (hash && stateRef.current.target?.origin === "passage") {
      publish({ target: null, status: "idle" });
    }
    const pendingPulse = consumePendingReaderPulse(mediaId);
    if (pendingPulse) {
      const pendingTarget = targetFromPulse(pendingPulse);
      if (pendingTarget) {
        publish({ target: pendingTarget, status: "pending" });
        return;
      }
    }
    if (mediaChanged) {
      publish({ target: null, status: "idle" });
    }
  }, [mediaId, paneHash, publish, resolvedPassage]);

  const onReaderPulse = useCallback(
    (detail: ReaderPulseTarget) => {
      if (detail.mediaId !== mediaId) return;
      consumePendingReaderPulse(mediaId, detail);
      const next = targetFromPulse(detail);
      if (!next) return;
      const current = stateRef.current;
      // The pulse channel still owns the visual pulse. Preserve a matching
      // hash target until markActive consumes its canonical URL obligation.
      if (
        current.status === "pending" &&
        current.target?.origin === "hash" &&
        current.target.kind === next.kind &&
        current.target.value === next.value
      ) {
        return;
      }
      publish({ target: next, status: "pending" });
    },
    [mediaId, publish],
  );
  useReaderPulseHighlight(onReaderPulse);

  const setTarget = useCallback((next: ReaderTarget) => {
    publish({ target: next, status: "pending" });
  }, [publish]);

  const markActive = useCallback((expectedTarget: ReaderTarget) => {
    const prev = stateRef.current.target;
    if (prev !== expectedTarget || stateRef.current.status !== "pending") return;
    publish({ target: prev, status: "active" });
    if (prev?.origin === "hash" || prev?.origin === "passage") {
      const pathname = paneRuntime?.pathname ?? window.location.pathname;
      const search =
        paneRuntime?.searchParams
          ? paneRuntime.searchParams.size > 0
            ? `?${paneRuntime.searchParams.toString()}`
            : ""
          : window.location.search;
      router.replace(pathname + search);
    }
  }, [paneRuntime?.pathname, paneRuntime?.searchParams, publish, router]);

  const clearTarget = useCallback(() => {
    publish({ target: null, status: "dismissed" });
  }, [publish]);

  return { target: state.target, status: state.status, setTarget, markActive, clearTarget, passageResolution };
}
