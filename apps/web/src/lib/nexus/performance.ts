"use client";

import { createContext, useContext, useLayoutEffect } from "react";

export const NEXUS_DESKTOP_OPEN_INPUT_READY =
  "nexus-desktop-open-input-ready";
export const NEXUS_DESKTOP_LOCAL_ROWS = "nexus-desktop-local-rows";
export const NEXUS_DESKTOP_PANE_ACTIVATE = "nexus-desktop-pane-activate";
export const NEXUS_DESKTOP_PROVIDERS_FIRST_USABLE =
  "nexus-desktop-providers-first-usable";

export type NexusProviderPhase = "Cold" | "Warm";
export type NexusProviderSource = "Openables" | "Owned";

type DesktopMeasure =
  | typeof NEXUS_DESKTOP_OPEN_INPUT_READY
  | typeof NEXUS_DESKTOP_LOCAL_ROWS
  | typeof NEXUS_DESKTOP_PANE_ACTIVATE
  | typeof NEXUS_DESKTOP_PROVIDERS_FIRST_USABLE;

type ActiveDesktopRun = {
  readonly runId: string;
  readonly targetId?: string;
};

const activeRuns = new Map<DesktopMeasure, ActiveDesktopRun>();
const activeProviderRuns = new Map<
  NexusProviderSource,
  ActiveDesktopRun
>();

function markName(measure: string, runId: string, edge: "Start" | "End") {
  return `${measure}.${runId}.${edge}`;
}

function begin(
  measure: DesktopMeasure,
  runId: string,
  options?: { readonly targetId?: string },
): void {
  if (typeof performance === "undefined") return;
  const previous = activeRuns.get(measure);
  if (previous) {
    performance.clearMarks(markName(measure, previous.runId, "Start"));
    performance.clearMarks(markName(measure, previous.runId, "End"));
  }
  activeRuns.set(measure, { runId, targetId: options?.targetId });
  performance.mark(markName(measure, runId, "Start"));
}

function complete(
  measure: DesktopMeasure,
  runId: string,
  detail?: Record<string, string>,
): void {
  if (typeof performance === "undefined") return;
  if (activeRuns.get(measure)?.runId !== runId) return;
  const start = markName(measure, runId, "Start");
  const end = markName(measure, runId, "End");
  if (performance.getEntriesByName(start, "mark").length === 0) return;
  performance.mark(end);
  performance.measure(measure, {
    start,
    end,
    ...(detail ? { detail } : {}),
  });
  performance.clearMarks(start);
  performance.clearMarks(end);
  activeRuns.delete(measure);
}

export function cancelNexusDesktopRun(
  measure: DesktopMeasure,
  runId: string,
): void {
  if (measure === NEXUS_DESKTOP_PROVIDERS_FIRST_USABLE) {
    for (const [source, active] of activeProviderRuns) {
      if (active.runId !== runId) continue;
      activeProviderRuns.delete(source);
      if (typeof performance === "undefined") return;
      performance.clearMarks(markName(measure, runId, "Start"));
      performance.clearMarks(markName(measure, runId, "End"));
      return;
    }
  }
  if (activeRuns.get(measure)?.runId !== runId) return;
  activeRuns.delete(measure);
  if (typeof performance === "undefined") return;
  performance.clearMarks(markName(measure, runId, "Start"));
  performance.clearMarks(markName(measure, runId, "End"));
}

export function beginNexusDesktopOpen(runId: string): void {
  begin(NEXUS_DESKTOP_OPEN_INPUT_READY, runId);
}

export function completeNexusDesktopOpenInputReady(runId: string): void {
  complete(NEXUS_DESKTOP_OPEN_INPUT_READY, runId);
}

export function beginNexusDesktopLocalRows(revision: string): void {
  begin(NEXUS_DESKTOP_LOCAL_ROWS, revision);
}

export function completeNexusDesktopLocalRows(revision: string): void {
  complete(NEXUS_DESKTOP_LOCAL_ROWS, revision);
}

export function beginNexusDesktopPaneActivation(
  runId: string,
  targetId: string,
): void {
  begin(NEXUS_DESKTOP_PANE_ACTIVATE, runId, { targetId });
}

export function completeNexusDesktopPanePaint(
  runId: string,
  targetId: string,
): void {
  if (activeRuns.get(NEXUS_DESKTOP_PANE_ACTIVATE)?.targetId !== targetId) {
    return;
  }
  complete(NEXUS_DESKTOP_PANE_ACTIVATE, runId);
}

export function beginNexusDesktopProviders(
  revision: string,
  source: NexusProviderSource,
): void {
  if (typeof performance === "undefined") return;
  const previous = activeProviderRuns.get(source);
  if (previous) {
    performance.clearMarks(
      markName(
        NEXUS_DESKTOP_PROVIDERS_FIRST_USABLE,
        previous.runId,
        "Start",
      ),
    );
    performance.clearMarks(
      markName(
        NEXUS_DESKTOP_PROVIDERS_FIRST_USABLE,
        previous.runId,
        "End",
      ),
    );
  }
  activeProviderRuns.set(source, { runId: revision });
  performance.mark(
    markName(NEXUS_DESKTOP_PROVIDERS_FIRST_USABLE, revision, "Start"),
  );
}

export function completeNexusDesktopProviders(
  revision: string,
  phase: NexusProviderPhase,
  source: NexusProviderSource,
): void {
  if (typeof performance === "undefined") return;
  if (activeProviderRuns.get(source)?.runId !== revision) return;
  const start = markName(
    NEXUS_DESKTOP_PROVIDERS_FIRST_USABLE,
    revision,
    "Start",
  );
  const end = markName(
    NEXUS_DESKTOP_PROVIDERS_FIRST_USABLE,
    revision,
    "End",
  );
  if (performance.getEntriesByName(start, "mark").length === 0) return;
  performance.mark(end);
  performance.measure(NEXUS_DESKTOP_PROVIDERS_FIRST_USABLE, {
    start,
    end,
    detail: { phase, source },
  });
  performance.clearMarks(start);
  performance.clearMarks(end);
  activeProviderRuns.delete(source);
}

export const NexusDesktopPanePerformanceContext = createContext<{
  readonly activationRouteId: string;
  readonly isActive: boolean;
} | null>(null);

export function useReportNexusDesktopPaneReady(): void {
  const pane = useContext(NexusDesktopPanePerformanceContext);
  useLayoutEffect(() => {
    if (!pane?.isActive) return;
    const active = activeRuns.get(NEXUS_DESKTOP_PANE_ACTIVATE);
    if (!active || active.targetId !== pane.activationRouteId) return;
    const frame = window.requestAnimationFrame(() => {
      window.setTimeout(() => {
        completeNexusDesktopPanePaint(active.runId, pane.activationRouteId);
      }, 0);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pane]);
}
