"use client";

import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useReaderContext } from "@/lib/reader/ReaderContext";
import { buildReaderSurfaceStyle } from "@/lib/reader/readerSurfaceStyle";
import type { WorkspacePrimaryMetrics } from "@/lib/workspace/paneSizing";

const probeBaseStyle: CSSProperties = {
  position: "fixed",
  top: "-10000px",
  left: "-10000px",
  visibility: "hidden",
  pointerEvents: "none",
  boxSizing: "content-box",
  width: "var(--reader-column-width-ch, 65ch)",
  height: 0,
  overflow: "hidden",
  paddingInline: "var(--space-4)",
  fontFamily: "var(--reader-font-family, var(--font-mono))",
  fontSize: "var(--reader-font-size-px, var(--text-md))",
  lineHeight: "var(--reader-line-height, var(--leading-normal))",
};

export function useWorkspacePrimaryMetrics(): {
  workspacePrimaryMetrics: WorkspacePrimaryMetrics | null;
  probe: ReactNode;
} {
  const { profile, loading } = useReaderContext();
  const probeRef = useRef<HTMLDivElement | null>(null);
  const [primaryWidthPx, setPrimaryWidthPx] = useState<number | null>(null);
  const readerSurfaceStyle = useMemo(() => buildReaderSurfaceStyle(profile), [profile]);

  useLayoutEffect(() => {
    if (loading) {
      setPrimaryWidthPx(null);
      return;
    }
    if (typeof ResizeObserver === "undefined") {
      throw new Error("ResizeObserver is required for workspace pane sizing.");
    }
    const node = probeRef.current;
    if (!node) {
      return;
    }
    const update = () => {
      const widthPx = Math.ceil(node.getBoundingClientRect().width);
      if (Number.isFinite(widthPx) && widthPx > 0) {
        setPrimaryWidthPx(widthPx);
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [loading, readerSurfaceStyle]);

  const workspacePrimaryMetrics = useMemo<WorkspacePrimaryMetrics | null>(() => {
    if (primaryWidthPx === null) {
      return null;
    }
    return {
      primaryMinWidthPx: primaryWidthPx,
      primaryDefaultWidthPx: primaryWidthPx,
    };
  }, [primaryWidthPx]);

  return {
    workspacePrimaryMetrics,
    probe: loading ? null : (
      <div
        ref={probeRef}
        aria-hidden="true"
        data-testid="workspace-primary-width-probe"
        style={{ ...probeBaseStyle, ...readerSurfaceStyle }}
      />
    ),
  };
}
