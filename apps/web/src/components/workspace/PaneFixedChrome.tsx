"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
} from "react";
import {
  arePaneFixedChromePublicationsEqual,
  type PaneFixedChromePublication,
} from "@/lib/panes/panePublications";

export const PaneFixedChromeContext = createContext<
  ((publication: PaneFixedChromePublication | null) => void) | null
>(null);

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
