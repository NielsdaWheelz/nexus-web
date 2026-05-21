import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AtlasPaneBody from "./AtlasPaneBody";

vi.mock("next/navigation", () => ({
  __esModule: true,
  default: {},
  usePathname: () => "/oracle/atlas",
  useRouter: () => ({
    push: vi.fn(),
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
});
