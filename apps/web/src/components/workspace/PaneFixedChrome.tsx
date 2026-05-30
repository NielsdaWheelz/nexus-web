"use client";

import {
  createContext,
  useContext,
  useLayoutEffect,
  type ReactNode,
} from "react";

export type PaneFixedChromeSlotId = "reader-overview-ruler";

export interface PaneFixedChromePublication {
  id: PaneFixedChromeSlotId;
  widthPx: number;
  body: ReactNode;
}

export const PaneFixedChromeContext = createContext<
  ((publication: PaneFixedChromePublication | null) => void) | null
>(null);

export function usePaneFixedChrome(
  publication: PaneFixedChromePublication | null,
): void {
  const setPublication = useContext(PaneFixedChromeContext);
  useLayoutEffect(() => {
    if (!setPublication) {
      return;
    }
    setPublication(publication);
    return () => setPublication(null);
  }, [publication, setPublication]);
}
