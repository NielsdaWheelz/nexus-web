"use client";

import { useReportWebVitals } from "next/web-vitals";
import { reportWebVital, type WebVitalReport } from "@/lib/workspace/telemetry";

const TRACKED: Record<string, WebVitalReport["name"]> = {
  LCP: "LCP",
  INP: "INP",
  CLS: "CLS",
  TTFB: "TTFB",
};

// RUM: stream the authenticated shell's Core Web Vitals (LCP/INP/CLS/TTFB) into
// the existing telemetry channel. Mounted inside AuthenticatedShell so the SLOs
// cover the authenticated routes this cutover targets (§15.4 / G7). Renders
// nothing; useReportWebVitals registers the browser observers on mount.
export function WebVitalsReporter(): null {
  useReportWebVitals((metric) => {
    const name = TRACKED[metric.name];
    if (!name) {
      return;
    }
    reportWebVital({ name, value: metric.value, rating: metric.rating, id: metric.id });
  });
  return null;
}
