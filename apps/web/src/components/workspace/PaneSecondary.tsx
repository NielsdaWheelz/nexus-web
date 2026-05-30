"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import type {
  WorkspaceSecondaryGroupId,
  WorkspaceSecondarySurfaceId,
} from "@/lib/panes/paneSecondaryModel";

export interface PaneSecondarySurfacePublication {
  readonly id: WorkspaceSecondarySurfaceId;
  readonly body: ReactNode;
  readonly mobileBody?: ReactNode;
}

export interface PaneSecondaryPublication {
  readonly groupId: WorkspaceSecondaryGroupId;
  readonly surfaces: readonly PaneSecondarySurfacePublication[];
  readonly defaultSurfaceId: WorkspaceSecondarySurfaceId;
}

export const PaneSecondaryContext = createContext<
  ((publication: PaneSecondaryPublication | null) => void) | null
>(null);

function arePaneSecondaryPublicationsEqual(
  left: PaneSecondaryPublication | null,
  right: PaneSecondaryPublication | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  if (
    left.groupId !== right.groupId ||
    left.defaultSurfaceId !== right.defaultSurfaceId ||
    left.surfaces.length !== right.surfaces.length
  ) {
    return false;
  }
  return left.surfaces.every((surface, index) => {
    const other = right.surfaces[index];
    return (
      other?.id === surface.id &&
      other.body === surface.body &&
      other.mobileBody === surface.mobileBody
    );
  });
}

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
