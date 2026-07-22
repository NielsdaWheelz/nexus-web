"use client";

import { createContext, useContext } from "react";
import { usePanePublication } from "@/components/workspace/usePanePublication";
import {
  arePaneSecondaryPublicationsEqual,
  type PaneSecondaryPublication,
} from "@/lib/panes/panePublications";

export const PaneSecondaryContext = createContext<
  ((publication: PaneSecondaryPublication | null) => void) | null
>(null);

export function usePaneSecondary(publication: PaneSecondaryPublication | null): void {
  const setPublication = useContext(PaneSecondaryContext);
  usePanePublication({
    publish: setPublication,
    publication,
    equals: arePaneSecondaryPublicationsEqual,
  });
}
