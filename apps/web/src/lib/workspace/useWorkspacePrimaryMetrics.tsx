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
import type { ReaderProfile } from "@/lib/reader/types";
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

// First-paint seed mirroring the probe box below: column_width_ch glyphs at
// ~0.5em advance + --space-4 (1rem) inline padding on both sides. The live probe
// refines this to the measured width before paint (useLayoutEffect), so the
// approximation never causes a visible jump.
function estimatePrimaryWidthPx(profile: ReaderProfile): number {
  return Math.ceil(profile.column_width_ch * profile.font_size_px * 0.5 + 2 * 16);
}

export function useWorkspacePrimaryMetrics(): {
  workspacePrimaryMetrics: WorkspacePrimaryMetrics;
  probe: ReactNode;
} {
  const { profile } = useReaderContext();
  const probeRef = useRef<HTMLDivElement | null>(null);
  const [primaryWidthPx, setPrimaryWidthPx] = useState(() =>
    estimatePrimaryWidthPx(profile),
  );
  const readerSurfaceStyle = useMemo(() => buildReaderSurfaceStyle(profile), [profile]);

  useLayoutEffect(() => {
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
  }, [readerSurfaceStyle]);

  const workspacePrimaryMetrics = useMemo<WorkspacePrimaryMetrics>(
    () => ({
      primaryMinWidthPx: primaryWidthPx,
      primaryDefaultWidthPx: primaryWidthPx,
    }),
    [primaryWidthPx],
  );

  return {
    workspacePrimaryMetrics,
    probe: (
      <div
        ref={probeRef}
        aria-hidden="true"
        data-testid="workspace-primary-width-probe"
        style={{ ...probeBaseStyle, ...readerSurfaceStyle }}
      />
    ),
  };
}
