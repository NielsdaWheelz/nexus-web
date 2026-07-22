"use client";

import type { AddSeed, LauncherLane } from "./model";

// One typed open event for every entry point. Add is a page intent, not a lane.
export const OPEN_LAUNCHER_EVENT = "nexus:open-launcher";

export type OpenLauncherDetail =
  | { kind: "Root"; lane?: LauncherLane; query?: string }
  | { kind: "Add"; seed: AddSeed };

export function dispatchOpenLauncher(detail?: OpenLauncherDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<OpenLauncherDetail>(OPEN_LAUNCHER_EVENT, {
      detail: detail ?? { kind: "Root" },
    }),
  );
}
