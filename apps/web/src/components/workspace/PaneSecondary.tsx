"use client";

import { createContext, useCallback, useContext, useRef } from "react";
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

type RequestPublishedSecondarySurface = (
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
  // A pane's surface set is data-derived (a reader publishes Contents only once
  // its outline loads), and the chrome that owns this command paints one commit
  // behind the publication it was built from. Read the publication through a ref
  // so the command is proved against the pane's CURRENT surfaces: a captured
  // publication rejects the very surface the control now targets, and that
  // rejection is silent with nothing to retry it.
  const publicationRef = useRef(publication);
  publicationRef.current = publication;
  return useCallback(
    (surfaceId, options) => {
      const current = publicationRef.current;
      if (
        !requestSecondarySurface ||
        !secondaryPublicationIncludesSurface(current, surfaceId)
      ) {
        return;
      }
      // The publication is the capability proof for this command. Reassert it
      // synchronously at selection time so a lifecycle cleanup cannot leave a
      // still-actionable Companion control racing a withdrawn host guard.
      setPublication?.(current);
      requestSecondarySurface(surfaceId, options);
    },
    [requestSecondarySurface, setPublication],
  );
}
