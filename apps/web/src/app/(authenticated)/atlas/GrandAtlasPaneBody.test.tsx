import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import {
  NEXUS_OPEN_PANE_EVENT,
  consumePendingPaneOpenQueue,
  parseOpenInAppPaneMessage,
} from "@/lib/panes/openInAppPane";
import GrandAtlasPaneBody from "./GrandAtlasPaneBody";
import {
  ALTITUDE_SPAN,
  HORIZON_RIM_MARGIN,
  ZENITH_MARGIN,
  fnv1a,
  projectToScreen,
  type CelestialPosition,
} from "./projection";
import { assumePaneVisitId } from "@/lib/workspace/schema";

const TEST_VISIT_ID = assumePaneVisitId(
  "00000000-0000-4000-8000-000000000001",
);

interface FixtureStar {
  media_id: string;
  x: number | null;
  y: number | null;
  title: string;
  kind: string;
  magnitude: number;
}

function star(over: Partial<FixtureStar> = {}): FixtureStar {
  return {
    media_id: over.media_id ?? "media-1",
    x: over.x === undefined ? 0.25 : over.x,
    y: over.y === undefined ? 0.5 : over.y,
    title: over.title ?? "A Work",
    kind: over.kind ?? "web_article",
    magnitude: over.magnitude ?? 3,
  };
}

function atlasResponse(over: {
  stars?: FixtureStar[];
  constellations?: unknown[];
  edges?: unknown[];
} = {}) {
  return {
    data: {
      stars: over.stars ?? [star()],
      constellations: over.constellations ?? [],
      edges: over.edges ?? [],
    },
  };
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

const W = 320;
const H = 320;
const RADIUS = Math.min(W / 2, H / 2) - 24;

function corpusCelestial(x: number, y: number): CelestialPosition {
  return { azimuth: x * Math.PI * 2, altitude: ZENITH_MARGIN + y * ALTITUDE_SPAN };
}

function screenPoint(celestial: CelestialPosition, cameraAzimuth = 0) {
  return projectToScreen(celestial, cameraAzimuth, W / 2, H / 2, RADIUS);
}

/**
 * requestOpenInAppPane resolves to one of three sinks depending on the frame: a
 * postMessage to window.parent (vitest runs the test in an iframe, so this is
 * the live path), a window CustomEvent (pane graph ready, same frame), or the
 * pending-open queue (graph not ready). Capture all three.
 */
function capturePaneOpenHrefs(): () => string[] {
  const hrefs: string[] = [];
  window.addEventListener(NEXUS_OPEN_PANE_EVENT, (event) => {
    const detail = (event as CustomEvent<{ href: string }>).detail;
    if (detail?.href) hrefs.push(detail.href);
  });
  const originalPostMessage = window.parent.postMessage.bind(window.parent);
  vi.spyOn(window.parent, "postMessage").mockImplementation(
    (...args: Parameters<typeof window.parent.postMessage>) => {
      const parsed = parseOpenInAppPaneMessage(args[0]);
      if (parsed?.href) hrefs.push(parsed.href);
      // Forward everything so vitest's own parent-frame comms keep working.
      return (originalPostMessage as (...a: unknown[]) => void)(...args);
    },
  );
  return () => [...hrefs, ...consumePendingPaneOpenQueue().map((item) => item.href)];
}

function atlasPane(over: { href?: string; onNavigatePane?: () => void } = {}) {
  const href = over.href ?? "/atlas";
  return (
    <PaneRuntimeProvider
      paneId="pane-1"
      visitId={TEST_VISIT_ID}
      isActive={true}
      href={href}
      routeId="atlas"
      routeKey={resolvePaneRouteIdentity(href).routeKey}
      canGoBack={false}
      canGoForward={false}
      onGoBackPane={vi.fn()}
      onGoForwardPane={vi.fn()}
      pathParams={{}}
      onNavigatePane={over.onNavigatePane ?? vi.fn()}
      onReplacePane={vi.fn()}
      onOpenInNewPane={vi.fn()}
    >
      <GrandAtlasPaneBody />
    </PaneRuntimeProvider>
  );
}

describe("GrandAtlasPaneBody", () => {
  beforeEach(() => {
    // Freeze idle rotation so click coordinates stay deterministic.
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, W, H),
    );
    vi.spyOn(HTMLCanvasElement.prototype, "setPointerCapture").mockImplementation(
      () => undefined,
    );
    consumePendingPaneOpenQueue();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("charts the corpus with both layer toggles (corpus on, readings off by default)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        if (path === "/api/atlas") return jsonResponse(atlasResponse());
        throw new Error(`Unexpected fetch: ${path}`);
      }),
    );
    render(atlasPane());

    expect(await screen.findByText("1 star")).toBeVisible();
    expect(screen.getByRole("button", { name: "Corpus" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Readings" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("highlights the readings layer when opened from /atlas?layer=readings", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        if (path === "/api/atlas") return jsonResponse(atlasResponse());
        if (path === "/api/oracle/readings") return jsonResponse({ data: [] });
        throw new Error(`Unexpected fetch: ${path}`);
      }),
    );
    render(atlasPane({ href: "/atlas?layer=readings" }));

    await screen.findByText("1 star");
    expect(screen.getByRole("button", { name: "Readings" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("toggles the corpus layer off and back on", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        if (path === "/api/atlas") return jsonResponse(atlasResponse());
        throw new Error(`Unexpected fetch: ${path}`);
      }),
    );
    render(atlasPane());
    const corpus = await screen.findByRole("button", { name: "Corpus" });

    fireEvent.click(corpus);
    expect(corpus).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(corpus);
    expect(corpus).toHaveAttribute("aria-pressed", "true");
  });

  it("lazily fetches oracle readings only once the readings layer is switched on", async () => {
    const fetchMock = vi.fn(async (path: string) => {
      if (path === "/api/atlas") return jsonResponse(atlasResponse());
      if (path === "/api/oracle/readings") return jsonResponse({ data: [] });
      throw new Error(`Unexpected fetch: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(atlasPane());
    await screen.findByText("1 star");

    expect(
      fetchMock.mock.calls.some(([path]) => path === "/api/oracle/readings"),
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Readings" }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([path]) => path === "/api/oracle/readings"),
      ).toBe(true);
    });
  });

  it("opens a corpus star in a new pane on click (never navigating the atlas itself)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        if (path === "/api/atlas") {
          return jsonResponse(atlasResponse({ stars: [star({ media_id: "m-42", x: 0.25, y: 0.5 })] }));
        }
        throw new Error(`Unexpected fetch: ${path}`);
      }),
    );
    const onNavigatePane = vi.fn();
    const paneOpens = capturePaneOpenHrefs();
    render(atlasPane({ onNavigatePane }));
    await screen.findByText("1 star");

    const canvas = screen.getByRole("img", {
      name: /celestial chart of the whole library/i,
    }) as HTMLCanvasElement;
    const point = screenPoint(corpusCelestial(0.25, 0.5));

    fireEvent.pointerDown(canvas, { clientX: point.x, clientY: point.y, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: point.x, clientY: point.y, pointerId: 1 });

    await waitFor(() => {
      expect(paneOpens()).toContain("/media/m-42");
    });
    // The atlas pane itself never navigates on a corpus click.
    expect(onNavigatePane).not.toHaveBeenCalled();
  });

  it("does not open a pane when the pointer dragged past the tap threshold", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        if (path === "/api/atlas") {
          return jsonResponse(atlasResponse({ stars: [star({ media_id: "m-7", x: 0.25, y: 0.5 })] }));
        }
        throw new Error(`Unexpected fetch: ${path}`);
      }),
    );
    const paneOpens = capturePaneOpenHrefs();
    render(atlasPane());
    await screen.findByText("1 star");
    const canvas = screen.getByRole("img", {
      name: /celestial chart of the whole library/i,
    }) as HTMLCanvasElement;
    const point = screenPoint(corpusCelestial(0.25, 0.5));

    fireEvent.pointerDown(canvas, { clientX: point.x, clientY: point.y, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: point.x + 40, clientY: point.y, pointerId: 1 });

    expect(paneOpens()).toHaveLength(0);
  });

  it("keeps the canvas touch-owned and rotates camera azimuth on horizontal drag", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        if (path === "/api/atlas") {
          return jsonResponse(
            atlasResponse({
              stars: [
                star({
                  media_id: "m-rotation",
                  x: 0.25,
                  y: 0.5,
                  title: "Rotating Work",
                }),
              ],
            }),
          );
        }
        throw new Error(`Unexpected fetch: ${path}`);
      }),
    );
    render(atlasPane());
    await screen.findByText("1 star");

    const canvas = screen.getByRole("img", {
      name: /celestial chart of the whole library/i,
    }) as HTMLCanvasElement;
    Object.defineProperty(canvas, "clientWidth", {
      configurable: true,
      value: W,
    });
    expect(getComputedStyle(canvas).touchAction).toBe("none");

    const celestial = corpusCelestial(0.25, 0.5);
    const initialPoint = screenPoint(celestial);
    fireEvent.pointerMove(canvas, {
      clientX: initialPoint.x,
      clientY: initialPoint.y,
    });
    expect(await screen.findByText("Rotating Work")).toBeInTheDocument();

    const dragDx = W / 4;
    fireEvent.pointerDown(canvas, {
      clientX: initialPoint.x,
      clientY: initialPoint.y,
      pointerId: 7,
    });
    fireEvent.pointerMove(canvas, {
      clientX: initialPoint.x + dragDx,
      clientY: initialPoint.y,
      pointerId: 7,
    });
    fireEvent.pointerUp(canvas, {
      clientX: initialPoint.x + dragDx,
      clientY: initialPoint.y,
      pointerId: 7,
    });

    fireEvent.pointerMove(canvas, {
      clientX: initialPoint.x,
      clientY: initialPoint.y,
    });
    await waitFor(() => {
      expect(screen.queryByText("Rotating Work")).not.toBeInTheDocument();
    });

    const rotatedPoint = screenPoint(celestial, Math.PI * 1.5);
    fireEvent.pointerMove(canvas, {
      clientX: rotatedPoint.x,
      clientY: rotatedPoint.y,
    });
    expect(await screen.findByText("Rotating Work")).toBeInTheDocument();
  });

  it("hit-tests a Nebula star (x:null) at the rim and shows its tooltip", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        if (path === "/api/atlas") {
          return jsonResponse(
            atlasResponse({ stars: [star({ media_id: "abc-def", x: null, y: null, title: "Unplaced Work" })] }),
          );
        }
        throw new Error(`Unexpected fetch: ${path}`);
      }),
    );
    render(atlasPane());
    await screen.findByText("1 star");

    const canvas = screen.getByRole("img", {
      name: /celestial chart of the whole library/i,
    }) as HTMLCanvasElement;
    const nebulaCelestial: CelestialPosition = {
      azimuth: (fnv1a("abcdef") / 0xffffffff) * Math.PI * 2,
      altitude: HORIZON_RIM_MARGIN * 0.4,
    };
    const point = screenPoint(nebulaCelestial);

    fireEvent.pointerMove(canvas, { clientX: point.x, clientY: point.y });

    // Presence of the tooltip proves the Nebula star (x:null, at the rim) was
    // hit-tested; the label fades in from opacity 0 so toBeVisible would race it.
    expect(await screen.findByText("Unplaced Work")).toBeInTheDocument();
  });

  it("draws a contradicts edge in a distinct color from a synapse context edge", async () => {
    const strokeStyles: unknown[] = [];
    const proto = CanvasRenderingContext2D.prototype;
    const original = Object.getOwnPropertyDescriptor(proto, "strokeStyle");
    Object.defineProperty(proto, "strokeStyle", {
      configurable: true,
      get() {
        return original?.get?.call(this);
      },
      set(value: unknown) {
        strokeStyles.push(value);
        original?.set?.call(this, value);
      },
    });

    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (path: string) => {
          if (path === "/api/atlas") {
            return jsonResponse(
              atlasResponse({
                stars: [
                  star({ media_id: "m-a", x: 0.2, y: 0.2 }),
                  star({ media_id: "m-b", x: 0.8, y: 0.8 }),
                ],
                edges: [
                  { source_media_id: "m-a", target_media_id: "m-b", kind: "context", origin: "synapse" },
                  { source_media_id: "m-b", target_media_id: "m-a", kind: "contradicts", origin: "user" },
                ],
              }),
            );
          }
          throw new Error(`Unexpected fetch: ${path}`);
        }),
      );
      render(atlasPane());
      await screen.findByText("2 stars");

      // A frame strokes: two dome rings + a synapse edge + a contradicts edge.
      // Four distinct strokeStyle values prove the contradicts path uses a
      // different color from the synapse path (three would mean they matched).
      await waitFor(() => {
        const distinct = new Set(strokeStyles.map((value) => String(value)));
        expect(distinct.size).toBeGreaterThanOrEqual(4);
      });
    } finally {
      if (original) Object.defineProperty(proto, "strokeStyle", original);
    }
  });

  it("navigates the pane router to the oracle folio on a readings-layer star click", async () => {
    const readings = [
      {
        id: "folio-9",
        folio_number: 9,
        folio_motto: "ad astra",
        folio_theme: "ascent",
        status: "complete",
      },
    ];
    const fetchMock = vi.fn(async (path: string) => {
      if (path === "/api/atlas") return jsonResponse(atlasResponse({ stars: [] }));
      if (path === "/api/oracle/readings") return jsonResponse({ data: readings });
      if (path === "/api/oracle/readings/folio-9/concordance") return jsonResponse({ data: [] });
      throw new Error(`Unexpected fetch: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const onNavigatePane = vi.fn();
    render(atlasPane({ href: "/atlas?layer=readings", onNavigatePane }));
    await screen.findByText("0 stars");

    const canvas = screen.getByRole("img", {
      name: /celestial chart of the whole library/i,
    }) as HTMLCanvasElement;
    // Compute the folio's celestial position via the same projection the body uses.
    const { celestialPosition } = await import("./projection");
    const point = screenPoint(celestialPosition(readings[0]!));

    // Wait until the readings layer has loaded and its stars are placed.
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([path]) => path === "/api/oracle/readings"),
      ).toBe(true);
    });
    // Hover to confirm the folio is now hittable before tapping.
    fireEvent.pointerMove(canvas, { clientX: point.x, clientY: point.y });
    await screen.findByText("ad astra");

    // First tap traces the constellation; second enters the folio.
    fireEvent.pointerDown(canvas, { clientX: point.x, clientY: point.y, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: point.x, clientY: point.y, pointerId: 1 });
    fireEvent.pointerDown(canvas, { clientX: point.x, clientY: point.y, pointerId: 2 });
    fireEvent.pointerUp(canvas, { clientX: point.x, clientY: point.y, pointerId: 2 });

    await waitFor(() => {
      expect(
        onNavigatePane.mock.calls.some(
          ([paneId, href]) =>
            paneId === "pane-1" &&
            typeof href === "string" &&
            href.includes("/oracle/folio-9"),
        ),
      ).toBe(true);
    });
  });
});
