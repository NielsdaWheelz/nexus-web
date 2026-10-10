import { absent, present, type Presence } from "@/lib/api/presence";
import { isApiError } from "@/lib/api/client";

interface ClientDefectReport {
  pane_id: string;
  visit_id: string;
  phase: "Render";
  command_id: Presence<string>;
  run_id: Presence<string>;
  error_code: string;
  request_id: Presence<string>;
  component_stack: string;
}
const reported = new WeakSet<object>();
let reports = 0;
const MAX_REPORTS = 32;
const CODE = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;

export function reportClientDefect(
  error: unknown,
  view: { paneId: string; visitId: string; componentStack: string },
): void {
  if (typeof window === "undefined" || reports >= MAX_REPORTS) return;
  if (error !== null && typeof error === "object") {
    if (reported.has(error)) return;
    reported.add(error);
  }
  reports += 1;
  const code =
    isApiError(error) && CODE.test(error.code) ? error.code : "E_CLIENT_DEFECT";
  const report: ClientDefectReport = {
    pane_id: view.paneId.slice(0, 128),
    visit_id: view.visitId.slice(0, 128),
    phase: "Render",
    command_id: absent(),
    run_id: absent(),
    error_code: code,
    request_id:
      isApiError(error) && error.requestId
        ? present(error.requestId.slice(0, 200))
        : absent(),
    component_stack: view.componentStack.slice(0, 8000),
  };
  try {
    navigator.sendBeacon(
      "/api/telemetry/client-defects",
      new Blob([JSON.stringify(report)], { type: "application/json" }),
    );
  } catch {
    // justify-ignore-error: optional telemetry delivery has no application-state
    // authority; browser beacon rejection is terminal and never reported again.
  }
}
