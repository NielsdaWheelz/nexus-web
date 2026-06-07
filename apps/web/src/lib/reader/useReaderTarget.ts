"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePaneRouter, usePaneRuntime } from "@/lib/panes/paneRuntime";
import {
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
  markActive: () => void;
  clearTarget: () => void;
}

function targetFromPulse(detail: ReaderPulseTarget): ReaderTarget | null {
  if (detail.evidenceSpanId) {
    return { kind: "evidence", value: detail.evidenceSpanId, origin: "pulse" };
  }
  if (detail.highlightId) {
    return { kind: "highlight", value: detail.highlightId, origin: "pulse" };
  }
  const loc = detail.locator;
  if (loc.type === "web_text_offsets" || loc.type === "epub_fragment_offsets") {
    return { kind: "fragment", value: loc.fragment_id, origin: "pulse" };
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
  const [state, setState] = useState<{
    target: ReaderTarget | null;
    status: ReaderTargetState["status"];
  }>(() => ({ target: null, status: "idle" }));
  const stateRef = useRef(state);
  const mediaIdRef = useRef(mediaId);
  stateRef.current = state;

  useEffect(() => {
    const mediaChanged = mediaIdRef.current !== mediaId;
    mediaIdRef.current = mediaId;
    const hash =
      typeof window === "undefined"
        ? ""
        : hasPaneRuntime
          ? hashFromPaneHref(paneHref)
          : window.location.hash;
    const parsed = parseReaderTargetHash(hash);
    if (parsed) {
      setState({ target: { ...parsed, origin: "hash" }, status: "pending" });
      return;
    }
    if (mediaChanged) {
      setState({ target: null, status: "idle" });
    }
  }, [hasPaneRuntime, mediaId, paneHref]);

  const onReaderPulse = useCallback(
    (detail: ReaderPulseTarget) => {
      if (detail.mediaId !== mediaId) return;
      const next = targetFromPulse(detail);
      if (!next) return;
      setState({ target: next, status: "pending" });
    },
    [mediaId],
  );
  useReaderPulseHighlight(onReaderPulse);

  const setTarget = useCallback((next: ReaderTarget) => {
    setState({ target: next, status: "pending" });
  }, []);

  const markActive = useCallback(() => {
    const prev = stateRef.current.target;
    setState((s) => ({ ...s, status: "active" }));
    if (prev?.origin === "hash") {
      const pathname = paneRuntime?.pathname ?? window.location.pathname;
      const search =
        paneRuntime?.searchParams
          ? paneRuntime.searchParams.size > 0
            ? `?${paneRuntime.searchParams.toString()}`
            : ""
          : window.location.search;
      router.replace(pathname + search);
    }
  }, [paneRuntime?.pathname, paneRuntime?.searchParams, router]);

  const clearTarget = useCallback(() => {
    setState({ target: null, status: "dismissed" });
  }, []);

  return { target: state.target, status: state.status, setTarget, markActive, clearTarget };
}
