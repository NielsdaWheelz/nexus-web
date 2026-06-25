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
  const lastPublishedRef = useRef<{
    setPublication: (publication: PaneFixedChromePublication | null) => void;
    publication: PaneFixedChromePublication | null;
  } | null>(null);
  useEffect(() => {
    if (!setPublication) {
      return;
    }
    const lastPublished = lastPublishedRef.current;
    if (
      lastPublished?.setPublication === setPublication &&
      arePaneFixedChromePublicationsEqual(lastPublished.publication, publication)
    ) {
      return;
    }
    lastPublishedRef.current = { setPublication, publication };
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
