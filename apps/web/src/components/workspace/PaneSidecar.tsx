"use client";

import {
  createContext,
  useContext,
  useLayoutEffect,
  type ComponentType,
  type ReactNode,
} from "react";
import type {
  WorkspaceSidecarGroupId,
  WorkspaceSidecarSurfaceId,
} from "@/lib/workspace/sidecarSizing";

export interface PaneSidecarSurface {
  id: WorkspaceSidecarSurfaceId;
  groupId: WorkspaceSidecarGroupId;
  title: string;
  icon: ComponentType<{ size?: number }>;
  body: ReactNode;
  mobileBody?: ReactNode;
}

export interface PaneSidecarDescriptor {
  groupId: WorkspaceSidecarGroupId;
  surfaces: PaneSidecarSurface[];
  defaultSurfaceId: WorkspaceSidecarSurfaceId;
}

export const PaneSidecarContext = createContext<
  ((descriptor: PaneSidecarDescriptor | null) => void) | null
>(null);

export function usePaneSidecar(descriptor: PaneSidecarDescriptor | null): void {
  const setDescriptor = useContext(PaneSidecarContext);
  useLayoutEffect(() => {
    if (!setDescriptor) {
      return;
    }
    setDescriptor(descriptor);
    return () => setDescriptor(null);
  }, [descriptor, setDescriptor]);
}
