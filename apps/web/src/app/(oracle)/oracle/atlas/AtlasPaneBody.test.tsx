import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AtlasPaneBody from "./AtlasPaneBody";
import { placeFolios, projectToScreen } from "./projection";

const { routerPushMock } = vi.hoisted(() => ({
  routerPushMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  __esModule: true,
  default: {},
  usePathname: () => "/oracle/atlas",
  useRouter: () => ({
    push: routerPushMock,
    replace: vi.fn(),
  }),
}));

interface FixtureReading {
  id: string;
  folio_number: number;
  folio_motto: string | null;
  folio_theme: string | null;
  status: string;
  plate_thumbnail_url: string | null;
  plate_alt_text: string | null;
  question_text: string;
}

function reading(over: Partial<FixtureReading> = {}): FixtureReading {
  return {
    id: over.id ?? "reading-1",
    folio_number: over.folio_number ?? 1,
    folio_motto: "folio_motto" in over ? over.folio_motto! : "vide cor meum",
    folio_theme: "folio_theme" in over ? over.folio_theme! : "threshold",
    status: over.status ?? "complete",
    plate_thumbnail_url: null,
    plate_alt_text: null,
    question_text: "Why this question?",
  };
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

describe("AtlasPaneBody", () => {
  afterEach(() => {
    vi.useRealTimers();
    routerPushMock.mockReset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows the empty-sky message when no folios have been consulted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        if (path === "/api/oracle/readings") return jsonResponse({ data: [] });
        throw new Error(`Unexpected fetch: ${path}`);
      }),
    );

    render(<AtlasPaneBody />);

    expect(
      await screen.findByText(
        /No folios consulted yet\. Ask the Oracle a question/,
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("link", { name: /Consult the oracle/ }),
    ).toHaveAttribute("href", "/oracle");
    expect(screen.getByText("no stars yet")).toBeVisible();
  });

  it("renders the dome, the star count, and an accessible link per folio", async () => {
    const readings = [
      reading({ id: "r1", folio_number: 1, folio_motto: "memento mori" }),
      reading({ id: "r2", folio_number: 2, folio_motto: "ad astra", folio_theme: "ascent" }),
      reading({ id: "r3", folio_number: 17, folio_motto: null, folio_theme: null }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        if (path === "/api/oracle/readings") return jsonResponse({ data: readings });
        throw new Error(`Unexpected fetch: ${path}`);
      }),
    );

    render(<AtlasPaneBody />);

    // The headline updates from "drawing the dome…" to a star count once data arrives.
    expect(await screen.findByText("3 stars")).toBeVisible();

    // The canvas mounts with the accessible label.
    expect(
      screen.getByRole("img", { name: /celestial map of consulted oracle folios/i }),
    ).toBeInTheDocument();

    // Every star is reachable via the visually-hidden list — keyboard users get
    // a complete index of the sky and can jump straight to any folio.
    expect(screen.getByRole("link", { name: /Folio I — memento mori/ })).toHaveAttribute(
      "href",
      "/oracle/r1",
    );
    expect(
      screen.getByRole("link", { name: /Folio II — ad astra \(ascent\)/ }),
    ).toHaveAttribute("href", "/oracle/r2");
    // Folio with no motto or theme still gets a row.
    expect(screen.getByRole("link", { name: /Folio XVII/ })).toHaveAttribute(
      "href",
      "/oracle/r3",
    );

    // The back link to the Aleph is always present.
    expect(screen.getByRole("link", { name: /← Aleph/ })).toHaveAttribute("href", "/oracle");
  });

  it("singularises the star count when there is exactly one folio", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        if (path === "/api/oracle/readings") {
          return jsonResponse({ data: [reading({ id: "r1" })] });
        }
        throw new Error(`Unexpected fetch: ${path}`);
      }),
    );

    render(<AtlasPaneBody />);

    expect(await screen.findByText("1 star")).toBeVisible();
  });

  it("aborts the summary request when the atlas unmounts", async () => {
    const summarySignals: AbortSignal[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string, init?: RequestInit) => {
        if (path === "/api/oracle/readings") {
          summarySignals.push(init?.signal as AbortSignal);
          return new Promise<Response>(() => undefined);
        }
        throw new Error(`Unexpected fetch: ${path}`);
      }),
    );

    const { unmount } = render(<AtlasPaneBody />);

    await waitFor(() => {
      expect(summarySignals).toHaveLength(1);
    });
    expect(summarySignals[0]!.aborted).toBe(false);

    unmount();

    expect(summarySignals[0]!.aborted).toBe(true);
  });

  it("cancels delayed star navigation on unmount", async () => {
    const readings = [reading({ id: "r1", folio_number: 1 })];
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 320, 320),
    );
    const fetchMock = vi.fn(async (path: string) => {
      if (path === "/api/oracle/readings") return jsonResponse({ data: readings });
      if (path === "/api/oracle/readings/r1/concordance") {
        return jsonResponse({ data: [] });
      }
      throw new Error(`Unexpected fetch: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { unmount } = render(<AtlasPaneBody />);

    expect(await screen.findByText("1 star")).toBeVisible();
    vi.useFakeTimers();
    const canvas = screen.getByRole("img", {
      name: /celestial map of consulted oracle folios/i,
    }) as HTMLCanvasElement;
    const w = 320;
    const h = 320;
    const star = placeFolios(readings)[0]!;
    const point = projectToScreen(star.celestial, 0, w / 2, h / 2, Math.min(w / 2, h / 2) - 24);

    fireEvent.pointerDown(canvas, { clientX: point.x, clientY: point.y, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: point.x, clientY: point.y, pointerId: 1 });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/oracle/readings/r1/concordance",
      expect.anything(),
    );
    expect(routerPushMock).not.toHaveBeenCalled();

    unmount();
    await vi.advanceTimersByTimeAsync(1100);

    expect(routerPushMock).not.toHaveBeenCalled();
  });

  it("aborts stale concordance loads and keeps the latest selected star peers", async () => {
    const readings = [
      reading({ id: "r1", folio_number: 1, folio_motto: "first" }),
      reading({ id: "r2", folio_number: 2, folio_motto: "second" }),
      reading({ id: "r3", folio_number: 3, folio_motto: "third" }),
      reading({ id: "r4", folio_number: 4, folio_motto: "fourth" }),
    ];
    const firstConcordance = deferred<Response>();
    const secondConcordance = deferred<Response>();
    const concordanceSignals: Record<string, AbortSignal> = {};
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 320, 320),
    );
    vi.spyOn(HTMLCanvasElement.prototype, "setPointerCapture").mockImplementation(
      () => undefined,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string, init?: RequestInit) => {
        if (path === "/api/oracle/readings") return Promise.resolve(jsonResponse({ data: readings }));
        if (path === "/api/oracle/readings/r1/concordance") {
          concordanceSignals.r1 = init?.signal as AbortSignal;
          return firstConcordance.promise;
        }
        if (path === "/api/oracle/readings/r2/concordance") {
          concordanceSignals.r2 = init?.signal as AbortSignal;
          return secondConcordance.promise;
        }
        throw new Error(`Unexpected fetch: ${path}`);
      }),
    );

    render(<AtlasPaneBody />);

    expect(await screen.findByText("4 stars")).toBeVisible();
    const canvas = screen.getByRole("img", {
      name: /celestial map of consulted oracle folios/i,
    }) as HTMLCanvasElement;
    const stars = placeFolios(readings);
    const first = stars.find((star) => star.id === "r1")!;
    const second = stars.find((star) => star.id === "r2")!;
    const firstPoint = projectToScreen(first.celestial, 0, 160, 160, 136);
    const secondPoint = projectToScreen(second.celestial, 0, 160, 160, 136);

    fireEvent.pointerDown(canvas, {
      clientX: firstPoint.x,
      clientY: firstPoint.y,
      pointerId: 1,
    });
    fireEvent.pointerUp(canvas, {
      clientX: firstPoint.x,
      clientY: firstPoint.y,
      pointerId: 1,
    });

    await waitFor(() => {
      expect(concordanceSignals.r1).toBeDefined();
    });
    expect(concordanceSignals.r1.aborted).toBe(false);

    fireEvent.pointerDown(canvas, {
      clientX: secondPoint.x,
      clientY: secondPoint.y,
      pointerId: 2,
    });
    fireEvent.pointerUp(canvas, {
      clientX: secondPoint.x,
      clientY: secondPoint.y,
      pointerId: 2,
    });

    await waitFor(() => {
      expect(concordanceSignals.r2).toBeDefined();
    });
    expect(concordanceSignals.r1.aborted).toBe(true);

    firstConcordance.resolve(
      jsonResponse({
        data: [
          concordanceEntry({ id: "r3", folio_number: 3 }),
          concordanceEntry({ id: "r4", folio_number: 4 }),
        ],
      }),
    );
    secondConcordance.resolve(
      jsonResponse({ data: [concordanceEntry({ id: "r3", folio_number: 3 })] }),
    );

    expect(
      await screen.findByText("Constellation of 1 · click again to enter"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Constellation of 2 · click again to enter"),
    ).not.toBeInTheDocument();
  });
});

function concordanceEntry(over: {
  id: string;
  folio_number: number;
}): {
  id: string;
  folio_number: number;
  folio_motto: string;
  folio_theme: string | null;
  shared_plate: boolean;
  shared_theme: boolean;
  shared_passage_count: number;
} {
  return {
    id: over.id,
    folio_number: over.folio_number,
    folio_motto: "peer motto",
    folio_theme: "peer theme",
    shared_plate: false,
    shared_theme: true,
    shared_passage_count: 0,
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
