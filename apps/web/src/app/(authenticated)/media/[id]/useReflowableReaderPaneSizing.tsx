"use client";

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import styles from "./page.module.css";

const EMPTY_READER_PANE_SIZING = { minWidthPx: null, extraWidthPx: 0 };

type ReaderColumnStyle = CSSProperties & {
  "--reader-protected-width-px"?: string;
};

export function useReflowableReaderPaneSizing(input: {
  enabled: boolean;
  readerSurfaceStyle: CSSProperties;
  overviewRulerWidthPx: number;
  secondaryRailWidthPx: number;
}): {
  protectedWidthProbe: ReactNode;
  readerColumnStyle: CSSProperties;
} {
  const paneRuntime = usePaneRuntime();
  const protectedReaderWidthRef = useRef<HTMLDivElement | null>(null);
  const [protectedReaderWidthPx, setProtectedReaderWidthPx] = useState(0);

  useLayoutEffect(() => {
    if (!input.enabled) {
      setProtectedReaderWidthPx(0);
      return;
    }

    const node = protectedReaderWidthRef.current;
    if (!node) {
      setProtectedReaderWidthPx(0);
      return;
    }
    if (typeof ResizeObserver === "undefined") {
      throw new Error("ResizeObserver is required for reflowable reader pane sizing.");
    }

    const updateProtectedWidth = () => {
      setProtectedReaderWidthPx(Math.ceil(node.getBoundingClientRect().width));
    };

    updateProtectedWidth();
    const observer = new ResizeObserver(updateProtectedWidth);
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [input.enabled, input.readerSurfaceStyle]);

  useEffect(() => {
    if (!paneRuntime) {
      return;
    }
    return () => {
      paneRuntime.setPaneSizing(EMPTY_READER_PANE_SIZING);
    };
  }, [paneRuntime]);

  useEffect(() => {
    if (!paneRuntime) {
      return;
    }
    paneRuntime.setPaneSizing({
      minWidthPx:
        input.enabled && protectedReaderWidthPx > 0
          ? protectedReaderWidthPx + input.overviewRulerWidthPx
          : null,
      extraWidthPx: input.enabled ? input.secondaryRailWidthPx : 0,
    });
  }, [
    input.enabled,
    input.overviewRulerWidthPx,
    input.secondaryRailWidthPx,
    paneRuntime,
    protectedReaderWidthPx,
  ]);

  const readerColumnStyle = useMemo<ReaderColumnStyle>(
    () => ({
      position: "relative",
      ...(input.enabled && protectedReaderWidthPx > 0
        ? { "--reader-protected-width-px": `${protectedReaderWidthPx}px` }
        : {}),
    }),
    [input.enabled, protectedReaderWidthPx]
  );

  return {
    protectedWidthProbe: input.enabled ? (
      <div
        ref={protectedReaderWidthRef}
        className={styles.readerProtectedWidthProbe}
        style={input.readerSurfaceStyle}
        aria-hidden="true"
      />
    ) : null,
    readerColumnStyle,
  };
}
