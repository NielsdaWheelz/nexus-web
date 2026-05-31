"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePaneRouter } from "@/lib/panes/paneRuntime";
import {
  isReaderPulseTarget,
  READER_PULSE_HIGHLIGHT,
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

export function useReaderTarget(mediaId: string): ReaderTargetState {
  const router = usePaneRouter();
  const [state, setState] = useState<{
    target: ReaderTarget | null;
    status: ReaderTargetState["status"];
  }>(() => ({ target: null, status: "idle" }));
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const parsed =
      typeof window === "undefined"
        ? null
        : parseReaderTargetHash(window.location.hash);
    setState(
      parsed
        ? { target: { ...parsed, origin: "hash" }, status: "pending" }
        : { target: null, status: "idle" },
    );
  }, [mediaId]);

  useEffect(() => {
    function listener(event: Event) {
      if (!(event instanceof CustomEvent) || !isReaderPulseTarget(event.detail)) {
        return;
      }
      const detail = event.detail;
      if (detail.mediaId !== mediaId) return;
      const next = targetFromPulse(detail);
      if (!next) return;
      setState({ target: next, status: "pending" });
    }
    window.addEventListener(READER_PULSE_HIGHLIGHT, listener);
    return () => window.removeEventListener(READER_PULSE_HIGHLIGHT, listener);
  }, [mediaId]);

  const setTarget = useCallback((next: ReaderTarget) => {
    setState({ target: next, status: "pending" });
  }, []);

  const markActive = useCallback(() => {
    const prev = stateRef.current.target;
    setState((s) => ({ ...s, status: "active" }));
    if (prev?.origin === "hash") {
      router.replace(window.location.pathname + window.location.search);
    }
  }, [router]);

  const clearTarget = useCallback(() => {
    setState({ target: null, status: "dismissed" });
  }, []);

  return { target: state.target, status: state.status, setTarget, markActive, clearTarget };
}
