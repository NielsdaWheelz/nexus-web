"use client";

export const WORKSPACE_TELEMETRY_EVENT = "nexus:workspace-telemetry";

export interface WorkspaceTelemetryDetail {
  type: "decode" | "encode";
  status: "ok" | "fallback" | "error";
  errorCode: string | null;
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
