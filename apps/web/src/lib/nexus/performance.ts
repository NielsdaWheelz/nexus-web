"use client";

import { createContext, useContext, useLayoutEffect } from "react";

export type NexusPerformanceMeasure =
  | "nexus-open"
  | "nexus-local-find"
  | "nexus-pane-activate"
  | "nexus-openables";

interface NexusPerformanceDefinition {
  readonly measure: NexusPerformanceMeasure;
  readonly start: string;
  readonly end: string;
  readonly decoded?: string;
}

export const NEXUS_OPEN_PERFORMANCE = {
  measure: "nexus-open",
  start: "nexus-open:start",
  end: "nexus-open:root-painted",
} as const satisfies NexusPerformanceDefinition;

export const NEXUS_LOCAL_FIND_PERFORMANCE = {
  measure: "nexus-local-find",
  start: "nexus-local-find:start",
  end: "nexus-local-find:local-rows-committed",
} as const satisfies NexusPerformanceDefinition;

export const NEXUS_PANE_ACTIVATE_PERFORMANCE = {
  measure: "nexus-pane-activate",
  start: "nexus-pane-activate:start",
  end: "nexus-pane-activate:pane-painted",
} as const satisfies NexusPerformanceDefinition;

export const NEXUS_OPENABLES_PERFORMANCE = {
  measure: "nexus-openables",
  start: "nexus-openables:start",
  decoded: "nexus-openables:decoded",
  end: "nexus-openables:results-committed",
} as const satisfies NexusPerformanceDefinition;

export interface NexusPerformanceRun {
  readonly id: number;
  readonly measure: NexusPerformanceMeasure;
}

interface ActiveNexusRun {
  readonly id: number;
  readonly targetId: string | null;
  decoded: boolean;
  completionScheduled: boolean;
}

const activeNexusRuns = new Map<NexusPerformanceMeasure, ActiveNexusRun>();
let nextNexusRunId = 0;

function supportsUserTiming(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.performance?.mark === "function" &&
    typeof window.performance?.measure === "function"
  );
}

function isActiveNexusRun(
  definition: NexusPerformanceDefinition,
  run: NexusPerformanceRun,
): boolean {
  return (
    run.measure === definition.measure &&
    activeNexusRuns.get(definition.measure)?.id === run.id
  );
}

export function beginNexusPerformance(
  definition: NexusPerformanceDefinition,
  options?: { readonly targetId?: string },
): NexusPerformanceRun | null {
  if (!supportsUserTiming()) return null;
  if (
    definition.measure === NEXUS_PANE_ACTIVATE_PERFORMANCE.measure &&
    !options?.targetId?.trim()
  ) {
    return null;
  }
  nextNexusRunId += 1;
  const run = { id: nextNexusRunId, measure: definition.measure };
  activeNexusRuns.set(definition.measure, {
    id: run.id,
    targetId: options?.targetId ?? null,
    decoded: definition.decoded === undefined,
    completionScheduled: false,
  });
  window.performance.clearMarks(definition.start);
  window.performance.clearMarks(definition.end);
  if (definition.decoded) window.performance.clearMarks(definition.decoded);
  window.performance.mark(definition.start);
  return run;
}

export function markNexusPerformanceDecoded(
  definition: NexusPerformanceDefinition & { readonly decoded: string },
  run: NexusPerformanceRun | null,
): void {
  if (!run || !supportsUserTiming() || !isActiveNexusRun(definition, run)) {
    return;
  }
  const active = activeNexusRuns.get(definition.measure);
  if (!active) return;
  active.decoded = true;
  window.performance.mark(definition.decoded);
}

export function cancelNexusPerformance(
  definition: NexusPerformanceDefinition,
  run: NexusPerformanceRun | null,
): void {
  if (!run || !isActiveNexusRun(definition, run)) return;
  activeNexusRuns.delete(definition.measure);
  if (!supportsUserTiming()) return;
  window.performance.clearMarks(definition.start);
  window.performance.clearMarks(definition.end);
  if (definition.decoded) window.performance.clearMarks(definition.decoded);
}

export function completeNexusPerformance(
  definition: NexusPerformanceDefinition,
  run?: NexusPerformanceRun | null,
): void {
  if (!supportsUserTiming()) return;
  const active = activeNexusRuns.get(definition.measure);
  if (!active || !active.decoded) return;
  if (run && (run.measure !== definition.measure || run.id !== active.id)) {
    return;
  }
  window.performance.mark(definition.end);
  window.performance.measure(
    definition.measure,
    definition.start,
    definition.end,
  );
  activeNexusRuns.delete(definition.measure);
  window.performance.clearMarks(definition.start);
  window.performance.clearMarks(definition.end);
  if (definition.decoded) window.performance.clearMarks(definition.decoded);
}

export function completeNexusPerformanceAfterPaint(
  definition: NexusPerformanceDefinition,
  run?: NexusPerformanceRun | null,
  targetId?: string,
): void {
  if (!supportsUserTiming()) return;
  const active = activeNexusRuns.get(definition.measure);
  if (
    !active ||
    active.completionScheduled ||
    (active.targetId !== null && active.targetId !== targetId) ||
    (run && (run.measure !== definition.measure || run.id !== active.id))
  ) {
    return;
  }
  active.completionScheduled = true;
  const runId = active.id;
  window.requestAnimationFrame(() => {
    window.setTimeout(() => {
      completeNexusPerformance(definition, {
        id: runId,
        measure: definition.measure,
      });
    }, 0);
  });
}

export const NexusPanePerformanceContext = createContext<{
  readonly activationRouteId: string;
  readonly isActive: boolean;
} | null>(null);

export function useReportNexusPaneReady(): void {
  const pane = useContext(NexusPanePerformanceContext);
  useLayoutEffect(() => {
    if (!pane?.isActive) return;
    completeNexusPerformanceAfterPaint(
      NEXUS_PANE_ACTIVATE_PERFORMANCE,
      undefined,
      pane.activationRouteId,
    );
  }, [pane]);
}
