"use client";

const WORKSPACE_TELEMETRY_EVENT = "nexus:workspace-telemetry";

interface WorkspaceTelemetryDetail {
  type: "title";
  status: "ok" | "fallback";
  errorCode: string | null;
  titleState: "resolved" | "pending";
  routeId: string;
}
export function emitWorkspaceTelemetry(detail: WorkspaceTelemetryDetail): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(
    new CustomEvent<WorkspaceTelemetryDetail>(WORKSPACE_TELEMETRY_EVENT, {
      detail,
    })
  );
  if (detail.status !== "ok" && detail.errorCode) {
    console.warn("workspace_telemetry", detail);
  }
}
