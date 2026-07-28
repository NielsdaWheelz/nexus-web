"use client";

import {
  createContext,
  useContext,
  useLayoutEffect,
} from "react";

export type SwitchboardPerformanceMeasure =
  | "nexus-open"
  | "nexus-local-find"
  | "nexus-pane-activate"
  | "nexus-openables";

interface SwitchboardPerformanceDefinition {
  readonly measure: SwitchboardPerformanceMeasure;
  readonly start: string;
  readonly end: string;
  readonly decoded?: string;
}

export const NEXUS_OPEN_PERFORMANCE = {
  measure: "nexus-open",
  start: "nexus-open:start",
  end: "nexus-open:root-painted",
} as const satisfies SwitchboardPerformanceDefinition;

export const NEXUS_LOCAL_FIND_PERFORMANCE = {
  measure: "nexus-local-find",
  start: "nexus-local-find:start",
  end: "nexus-local-find:local-rows-committed",
} as const satisfies SwitchboardPerformanceDefinition;

export const NEXUS_PANE_ACTIVATE_PERFORMANCE = {
  measure: "nexus-pane-activate",
  start: "nexus-pane-activate:start",
  end: "nexus-pane-activate:pane-painted",
} as const satisfies SwitchboardPerformanceDefinition;

export const NEXUS_OPENABLES_PERFORMANCE = {
  measure: "nexus-openables",
  start: "nexus-openables:start",
  decoded: "nexus-openables:decoded",
  end: "nexus-openables:results-committed",
} as const satisfies SwitchboardPerformanceDefinition;

export interface SwitchboardPerformanceRun {
  readonly id: number;
  readonly measure: SwitchboardPerformanceMeasure;
}

interface ActiveRun {
  readonly id: number;
  readonly targetId: string | null;
  decoded: boolean;
  completionScheduled: boolean;
}

const activeRuns = new Map<SwitchboardPerformanceMeasure, ActiveRun>();
const AFTER_PAINT_TASK_DELAY_MS = 0;
let nextRunId = 0;

function supportsUserTiming(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.performance?.mark === "function" &&
    typeof window.performance?.measure === "function"
  );
}

function isActiveRun(
  definition: SwitchboardPerformanceDefinition,
  run: SwitchboardPerformanceRun,
): boolean {
  return (
    run.measure === definition.measure &&
    activeRuns.get(definition.measure)?.id === run.id
  );
}

export function beginSwitchboardPerformance(
  definition: SwitchboardPerformanceDefinition,
  options?: { readonly targetId?: string },
): SwitchboardPerformanceRun | null {
  if (!supportsUserTiming()) return null;
  if (
    definition.measure === NEXUS_PANE_ACTIVATE_PERFORMANCE.measure &&
    !options?.targetId?.trim()
  ) {
    return null;
  }
  nextRunId += 1;
  const run = { id: nextRunId, measure: definition.measure };
  activeRuns.set(definition.measure, {
    id: run.id,
    targetId: options?.targetId ?? null,
    decoded: definition.decoded === undefined,
    completionScheduled: false,
  });
  window.performance.clearMarks(definition.start);
  window.performance.clearMarks(definition.end);
  if (definition.decoded) {
    window.performance.clearMarks(definition.decoded);
  }
  window.performance.mark(definition.start);
  return run;
}

export function markSwitchboardPerformanceDecoded(
  definition: SwitchboardPerformanceDefinition & { readonly decoded: string },
  run: SwitchboardPerformanceRun | null,
): void {
  if (!run || !supportsUserTiming() || !isActiveRun(definition, run)) return;
  const active = activeRuns.get(definition.measure);
  if (!active) return;
  active.decoded = true;
  window.performance.mark(definition.decoded);
}

export function cancelSwitchboardPerformance(
  definition: SwitchboardPerformanceDefinition,
  run: SwitchboardPerformanceRun | null,
): void {
  if (!run || !isActiveRun(definition, run)) return;
  activeRuns.delete(definition.measure);
  if (!supportsUserTiming()) return;
  window.performance.clearMarks(definition.start);
  window.performance.clearMarks(definition.end);
  if (definition.decoded) {
    window.performance.clearMarks(definition.decoded);
  }
}

export function completeSwitchboardPerformance(
  definition: SwitchboardPerformanceDefinition,
  run?: SwitchboardPerformanceRun | null,
): void {
  if (!supportsUserTiming()) return;
  const active = activeRuns.get(definition.measure);
  if (!active || !active.decoded) return;
  if (
    run &&
    (run.measure !== definition.measure || run.id !== active.id)
  ) {
    return;
  }
  window.performance.mark(definition.end);
  window.performance.measure(
    definition.measure,
    definition.start,
    definition.end,
  );
  activeRuns.delete(definition.measure);
  window.performance.clearMarks(definition.start);
  window.performance.clearMarks(definition.end);
  if (definition.decoded) {
    window.performance.clearMarks(definition.decoded);
  }
}

export function completeSwitchboardPerformanceAfterPaint(
  definition: SwitchboardPerformanceDefinition,
  run?: SwitchboardPerformanceRun | null,
  targetId?: string,
): void {
  if (!supportsUserTiming()) return;
  const active = activeRuns.get(definition.measure);
  if (
    !active ||
    active.completionScheduled ||
    (active.targetId !== null && active.targetId !== targetId) ||
    (run &&
      (run.measure !== definition.measure || run.id !== active.id))
  ) {
    return;
  }
  active.completionScheduled = true;
  const runId = active.id;
  window.requestAnimationFrame(() => {
    window.setTimeout(() => {
      completeSwitchboardPerformance(definition, {
        id: runId,
        measure: definition.measure,
      });
    }, AFTER_PAINT_TASK_DELAY_MS);
  });
}

interface SwitchboardPanePerformanceValue {
  readonly activationRouteId: string;
  readonly isActive: boolean;
}

export const SwitchboardPanePerformanceContext =
  createContext<SwitchboardPanePerformanceValue | null>(null);

export function useReportSwitchboardPaneReady(): void {
  const pane = useContext(SwitchboardPanePerformanceContext);
  useLayoutEffect(() => {
    if (!pane?.isActive) return;
    completeSwitchboardPerformanceAfterPaint(
      NEXUS_PANE_ACTIVATE_PERFORMANCE,
      undefined,
      pane.activationRouteId,
    );
  }, [pane]);
}
