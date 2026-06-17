"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from "react";

export interface PaneFixedChromePublication {
  id: "reader-document-map-overview-rail";
  widthPx: number;
  body: ReactNode;
}

export const PaneFixedChromeContext = createContext<
  ((publication: PaneFixedChromePublication | null) => void) | null
>(null);

function arePaneFixedChromePublicationsEqual(
  left: PaneFixedChromePublication | null,
  right: PaneFixedChromePublication | null,
): boolean {
  return (
    left === right ||
    Boolean(
      left &&
        right &&
        left.id === right.id &&
        left.widthPx === right.widthPx &&
        left.body === right.body,
    )
  );
}

export function usePaneFixedChrome(
  publication: PaneFixedChromePublication | null,
): void {
  const setPublication = useContext(PaneFixedChromeContext);
  const lastPublishedRef = useRef<PaneFixedChromePublication | null>(null);
  useEffect(() => {
    if (!setPublication) {
      return;
    }
    if (arePaneFixedChromePublicationsEqual(lastPublishedRef.current, publication)) {
      return;
    }
    lastPublishedRef.current = publication;
    setPublication(publication);
  }, [publication, setPublication]);

  useEffect(() => {
    if (!setPublication) {
      return;
    }
    return () => {
      lastPublishedRef.current = null;
      setPublication(null);
    };
  }, [setPublication]);
}
