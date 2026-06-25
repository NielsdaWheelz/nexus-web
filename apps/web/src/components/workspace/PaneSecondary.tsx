"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
} from "react";
import {
  arePaneSecondaryPublicationsEqual,
  type PaneSecondaryPublication,
} from "@/lib/panes/panePublications";

export const PaneSecondaryContext = createContext<
  ((publication: PaneSecondaryPublication | null) => void) | null
>(null);

export function usePaneSecondary(publication: PaneSecondaryPublication | null): void {
  const setPublication = useContext(PaneSecondaryContext);
  const lastPublishedRef = useRef<{
    setPublication: (publication: PaneSecondaryPublication | null) => void;
    publication: PaneSecondaryPublication | null;
  } | null>(null);
  useEffect(() => {
    if (!setPublication) {
      return;
    }
    const lastPublished = lastPublishedRef.current;
    if (
      lastPublished?.setPublication === setPublication &&
      arePaneSecondaryPublicationsEqual(lastPublished.publication, publication)
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
