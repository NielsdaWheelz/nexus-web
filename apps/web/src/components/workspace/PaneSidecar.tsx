"use client";

import {
  createContext,
  useContext,
  useLayoutEffect,
  type ReactNode,
} from "react";
import type {
  WorkspaceSidecarGroupId,
  WorkspaceSidecarSurfaceId,
} from "@/lib/panes/paneSidecarModel";

export interface PaneSidecarSurfacePublication {
  id: WorkspaceSidecarSurfaceId;
  body: ReactNode;
  mobileBody?: ReactNode;
}

export interface PaneSidecarPublication {
  groupId: WorkspaceSidecarGroupId;
  surfaces: PaneSidecarSurfacePublication[];
  defaultSurfaceId: WorkspaceSidecarSurfaceId;
}

export const PaneSidecarContext = createContext<
  ((publication: PaneSidecarPublication | null) => void) | null
>(null);

export function usePaneSidecar(publication: PaneSidecarPublication | null): void {
  const setPublication = useContext(PaneSidecarContext);
  useLayoutEffect(() => {
    if (!setPublication) {
      return;
    }
    setPublication(publication);
    return () => setPublication(null);
  }, [publication, setPublication]);
}
