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

const WEB_VITALS_EVENT = "nexus:web-vitals";

export interface WebVitalReport {
  name: "LCP" | "INP" | "CLS" | "TTFB";
  value: number;
  rating: "good" | "needs-improvement" | "poor";
  id: string;
}

// RUM Core Web Vitals flow through the same window-event telemetry channel as the
// rest of the workspace (O-4: reuse the existing sink, no new vendor). Poor
// samples also warn so a first-paint regression surfaces in the console (§15.4).
export function reportWebVital(report: WebVitalReport): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(
    new CustomEvent<WebVitalReport>(WEB_VITALS_EVENT, { detail: report })
  );
  if (report.rating === "poor") {
    console.warn("web_vitals", report);
  }
}
