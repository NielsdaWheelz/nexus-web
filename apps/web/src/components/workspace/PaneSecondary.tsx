"use client";

import { createContext, useCallback, useContext } from "react";
import { usePanePublication } from "@/components/workspace/usePanePublication";
import {
  arePaneSecondaryPublicationsEqual,
  secondaryPublicationIncludesSurface,
  type PaneSecondaryPublication,
} from "@/lib/panes/panePublications";
import {
  usePaneRuntime,
  type PaneSecondarySurfaceRequestOptions,
} from "@/lib/panes/paneRuntime";
import type { WorkspaceSecondarySurfaceId } from "@/lib/panes/paneSecondaryModel";

export const PaneSecondaryContext = createContext<
  ((publication: PaneSecondaryPublication | null) => void) | null
>(null);

export type RequestPublishedSecondarySurface = (
  surfaceId: WorkspaceSecondarySurfaceId,
  options?: PaneSecondarySurfaceRequestOptions,
) => void;

export function usePaneSecondary(
  publication: PaneSecondaryPublication | null,
): RequestPublishedSecondarySurface {
  const setPublication = useContext(PaneSecondaryContext);
  const requestSecondarySurface = usePaneRuntime()?.requestSecondarySurface;
  usePanePublication({
    publish: setPublication,
    publication,
    equals: arePaneSecondaryPublicationsEqual,
  });
  return useCallback(
    (surfaceId, options) => {
      if (
        !requestSecondarySurface ||
        !secondaryPublicationIncludesSurface(publication, surfaceId)
      ) {
        return;
      }
      // The publication is the capability proof for this command. Reassert it
      // synchronously at selection time so a lifecycle cleanup cannot leave a
      // still-actionable Companion control racing a withdrawn host guard.
      setPublication?.(publication);
      requestSecondarySurface(surfaceId, options);
    },
    [publication, requestSecondarySurface, setPublication],
  );
}
