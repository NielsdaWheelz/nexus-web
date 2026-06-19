"use client";

import type { LauncherLane } from "./model";

// One open event for every entry point (Cmd-K, the rail/mobile command buttons, the "+"
// button). The "+" seeds the add lane.
export const OPEN_LAUNCHER_EVENT = "nexus:open-launcher";

export interface OpenLauncherDetail {
  lane?: LauncherLane; // seed a lane (the "+" button passes "add")
  query?: string;
}

export function dispatchOpenLauncher(detail?: OpenLauncherDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<OpenLauncherDetail>(OPEN_LAUNCHER_EVENT, { detail: detail ?? {} }));
}
