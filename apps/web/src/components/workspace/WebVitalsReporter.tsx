"use client";

import { useRef } from "react";
import { useReportWebVitals } from "next/web-vitals";
import { createRandomId } from "@/lib/createRandomId";

const TRACKED = ["LCP", "INP", "CLS", "TTFB"] as const;
type TrackedVital = (typeof TRACKED)[number];
const isTracked = (name: string): name is TrackedVital =>
  (TRACKED as readonly string[]).includes(name);

const SINK_PATH = "/api/telemetry/web-vitals";

// RUM: beacon the authenticated shell's Core Web Vitals (LCP/INP/CLS/TTFB) to the FastAPI
// sink via the BFF (§3.5 / G6), where they are logged under the request_id. Mounted inside
// AuthenticatedShell so the SLOs cover the authenticated routes this cutover targets. Renders
// nothing; useReportWebVitals registers the browser observers on mount and invokes the
// callback per metric.
export function WebVitalsReporter(): null {
  // Per-page-load nav id: one id shared by every vital from this load, regenerated on reload.
  // Lazy-init in render (not useRef(createRandomId())) so a parent re-render never mints and
  // discards a fresh UUID.
  const navIdRef = useRef<string>("");
  if (!navIdRef.current) {
    navIdRef.current = createRandomId();
  }

  useReportWebVitals((metric) => {
    if (!isTracked(metric.name)) {
      return;
    }
    // href: path-only (never the hash, which can carry reader selection).
    const payload = JSON.stringify({
      name: metric.name,
      value: metric.value,
      rating: metric.rating,
      id: metric.id,
      href: window.location.pathname + window.location.search,
      nav_id: navIdRef.current,
    });
    // LCP/INP fire at/after pagehide, so the send must survive unload: sendBeacon queues
    // out-of-band. The application/json Blob makes the proxy forward the content-type.
    try {
      navigator.sendBeacon(SINK_PATH, new Blob([payload], { type: "application/json" }));
    } catch {
      // justify-ignore-error: RUM is best-effort observability; a failed beacon must never
      // affect the page.
    }
  });

  return null;
}
