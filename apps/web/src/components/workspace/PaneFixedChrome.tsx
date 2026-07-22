"use client";

import { createContext, useContext } from "react";
import { usePanePublication } from "@/components/workspace/usePanePublication";
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
  usePanePublication({
    publish: setPublication,
    publication,
    equals: arePaneFixedChromePublicationsEqual,
  });
}
