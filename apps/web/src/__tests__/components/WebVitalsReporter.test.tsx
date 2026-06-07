import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// next/web-vitals ships compiled CommonJS that references `__dirname`, which the Vitest
// browser bundler cannot evaluate. Stub this framework boundary (NOT an internal app module)
// and capture the registered callback so the test can drive it with a metric exactly as
// Next's observer would — exercising the real component path (filter → beacon).
type WebVitalMetric = { name: string; value: number; rating: string; id: string };
let reportMetric: ((metric: WebVitalMetric) => void) | null = null;
vi.mock("next/web-vitals", () => ({
  useReportWebVitals: (callback: (metric: WebVitalMetric) => void) => {
    reportMetric = callback;
  },
}));

import { WebVitalsReporter } from "@/components/workspace/WebVitalsReporter";

const SINK_PATH = "/api/telemetry/web-vitals";

async function readBeaconBody(blob: BodyInit | null | undefined): Promise<unknown> {
  if (!(blob instanceof Blob)) {
    throw new Error(`Expected a Blob beacon body, got ${typeof blob}`);
  }
  return JSON.parse(await blob.text());
}

function mountReporter() {
  const beacon = vi.fn((_url: string | URL, _body?: BodyInit | null) => true);
  // Boundary stub only: the unload-safe send mechanism the component calls.
  vi.spyOn(navigator, "sendBeacon").mockImplementation(beacon);
  render(<WebVitalsReporter />);
  if (!reportMetric) {
    throw new Error("WebVitalsReporter never registered a web-vitals callback");
  }
  return { beacon, report: reportMetric };
}

describe("WebVitalsReporter", () => {
  it("beacons a tracked vital to the sink with the exact snake_case payload", async () => {
    const { beacon, report } = mountReporter();

    report({ name: "LCP", value: 1234.5, rating: "good", id: "v1-abc" });

    expect(beacon).toHaveBeenCalledTimes(1);
    const [url, body] = beacon.mock.calls[0]!;
    expect(url).toBe(SINK_PATH);

    const blob = body as Blob;
    expect(blob.type).toBe("application/json");

    const payload = (await readBeaconBody(body)) as Record<string, unknown>;
    expect(payload).toMatchObject({
      name: "LCP",
      value: 1234.5,
      rating: "good",
      id: "v1-abc",
    });

    // Exact snake_case keys, no camelCase navId, no extras (backend extra="forbid").
    expect(Object.keys(payload).sort()).toEqual([
      "href",
      "id",
      "name",
      "nav_id",
      "rating",
      "value",
    ]);
    // href is path-only (window.location pathname+search); never the hash.
    expect(payload.href).toBe(window.location.pathname + window.location.search);
    expect(String(payload.href)).not.toContain("#");
    // nav_id is a non-empty per-page-load id.
    expect(typeof payload.nav_id).toBe("string");
    expect(payload.nav_id).not.toBe("");
  });

  it("ignores untracked metrics (e.g. Next.js custom metrics, FCP)", () => {
    const { beacon, report } = mountReporter();

    report({ name: "FCP", value: 100, rating: "good", id: "fcp-1" });
    report({ name: "Next.js-hydration", value: 50, rating: "good", id: "nh-1" });

    expect(beacon).not.toHaveBeenCalled();
  });

  it("reuses one nav_id across multiple samples from the same page load", async () => {
    const { beacon, report } = mountReporter();

    report({ name: "TTFB", value: 80, rating: "good", id: "ttfb-1" });
    report({ name: "CLS", value: 0.01, rating: "good", id: "cls-1" });

    expect(beacon).toHaveBeenCalledTimes(2);
    const first = (await readBeaconBody(beacon.mock.calls[0]![1])) as Record<string, unknown>;
    const second = (await readBeaconBody(beacon.mock.calls[1]![1])) as Record<string, unknown>;
    expect(first.nav_id).toBe(second.nav_id);
  });
});
