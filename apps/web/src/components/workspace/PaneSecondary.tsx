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
  const lastPublishedRef = useRef<PaneSecondaryPublication | null>(null);
  useEffect(() => {
    if (!setPublication) {
      return;
    }
    if (arePaneSecondaryPublicationsEqual(lastPublishedRef.current, publication)) {
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
