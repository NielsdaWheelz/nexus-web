"use client";

import { useViewportState } from "@/lib/renderEnvironment/provider";

export function useIsMobileViewport(): boolean {
  return useViewportState().isMobile;
}
