import { describe, expect, it } from "vitest";
import {
  celestialPosition,
  fnv1a,
  placeFolios,
  projectToScreen,
  squaredDistance,
  starMagnitude,
  type FolioStarInput,
} from "./projection";

function folio(over: Partial<FolioStarInput> = {}): FolioStarInput {
  // Use `in` checks so explicit `null` overrides aren't silently turned into defaults.
  return {
    id: "id" in over ? over.id! : "id-1",
    folio_number: "folio_number" in over ? over.folio_number! : 1,
    folio_motto: "folio_motto" in over ? over.folio_motto! : "vide cor meum",
    folio_theme: "folio_theme" in over ? over.folio_theme! : "threshold",
    status: "status" in over ? over.status! : "complete",
  };
}

describe("fnv1a", () => {
  it("returns a stable 32-bit unsigned integer", () => {
    const h = fnv1a("hello");
    expect(Number.isInteger(h)).toBe(true);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
  });

  it("is deterministic", () => {
    expect(fnv1a("threshold")).toBe(fnv1a("threshold"));
  });

  it("distinguishes different inputs", () => {
    expect(fnv1a("threshold")).not.toBe(fnv1a("descent"));
  });

  it("handles the empty string", () => {
    // FNV-1a offset basis for empty input
    expect(fnv1a("")).toBe(0x811c9dc5);
  });
});

describe("celestialPosition", () => {
  it("is deterministic for the same folio", () => {
    const a = celestialPosition(folio());
    const b = celestialPosition(folio());
    expect(a.azimuth).toBe(b.azimuth);
    expect(a.altitude).toBe(b.altitude);
  });

  it("stays inside the dome (altitude in [margin, π/2 - margin])", () => {
    for (let i = 0; i < 100; i++) {
      const pos = celestialPosition(
        folio({ id: `id-${i}`, folio_number: i, folio_motto: `motto ${i}` }),
      );
      expect(pos.altitude).toBeGreaterThan(0);
      expect(pos.altitude).toBeLessThan(Math.PI / 2);
      expect(pos.azimuth).toBeGreaterThanOrEqual(0);
      expect(pos.azimuth).toBeLessThan(Math.PI * 2);
    }
  });

  it("clusters same-theme folios at the same azimuth", () => {
    const a = celestialPosition(folio({ id: "a", folio_motto: "alpha", folio_number: 1 }));
    const b = celestialPosition(folio({ id: "b", folio_motto: "beta", folio_number: 2 }));
    // Same theme means same azimuth — the heart of the constellation effect.
    expect(a.azimuth).toBe(b.azimuth);
    // But different mottos and numbers mean different altitudes — they don't stack.
    expect(a.altitude).not.toBe(b.altitude);
  });

  it("separates different-theme folios into different azimuths", () => {
    const a = celestialPosition(folio({ folio_theme: "descent" }));
    const b = celestialPosition(folio({ folio_theme: "ascent" }));
    expect(a.azimuth).not.toBe(b.azimuth);
  });

  it("is case-insensitive on theme", () => {
    const a = celestialPosition(folio({ folio_theme: "Threshold" }));
    const b = celestialPosition(folio({ folio_theme: "threshold" }));
    expect(a.azimuth).toBe(b.azimuth);
  });

  it("falls back to motto when theme is missing", () => {
    const themed = celestialPosition(folio({ folio_theme: "shared", folio_motto: "x" }));
    const themeless = celestialPosition(folio({ folio_theme: null, folio_motto: "x" }));
    // Different keys → different positions (motto-keyed folio uses a different prefix).
    expect(themeless.azimuth).not.toBe(themed.azimuth);
  });

  it("falls back to id when both theme and motto are missing", () => {
    const a = celestialPosition(folio({ id: "alpha", folio_theme: null, folio_motto: null }));
    const b = celestialPosition(folio({ id: "beta", folio_theme: null, folio_motto: null }));
    expect(a.azimuth).not.toBe(b.azimuth);
  });
});

describe("projectToScreen", () => {
  const center = 200;
  const radius = 180;

  it("maps zenith (altitude π/2) to the screen center", () => {
    const pos = projectToScreen(
      { azimuth: 1.23, altitude: Math.PI / 2 },
      0,
      center,
      center,
      radius,
    );
    expect(pos.x).toBeCloseTo(center, 6);
    expect(pos.y).toBeCloseTo(center, 6);
    expect(pos.r).toBeCloseTo(0, 6);
  });

  it("maps horizon (altitude 0) to the rim", () => {
    const pos = projectToScreen(
      { azimuth: 0, altitude: 0 },
      0,
      center,
      center,
      radius,
    );
    expect(pos.r).toBeCloseTo(radius, 6);
    // Azimuth 0 should land at top of screen (y = center - radius).
    expect(pos.x).toBeCloseTo(center, 6);
    expect(pos.y).toBeCloseTo(center - radius, 6);
  });

  it("places azimuth π/2 (east) to the right of center", () => {
    const pos = projectToScreen(
      { azimuth: Math.PI / 2, altitude: 0 },
      0,
      center,
      center,
      radius,
    );
    expect(pos.x).toBeCloseTo(center + radius, 6);
    expect(pos.y).toBeCloseTo(center, 6);
  });

  it("rotates the sky by subtracting cameraAzimuth", () => {
    const star = { azimuth: Math.PI / 2, altitude: 0 };
    // Camera at π/2 → the star at π/2 should now appear at the top (north).
    const pos = projectToScreen(star, Math.PI / 2, center, center, radius);
    expect(pos.x).toBeCloseTo(center, 6);
    expect(pos.y).toBeCloseTo(center - radius, 6);
  });
});

describe("placeFolios", () => {
  it("attaches a celestial position to each input", () => {
    const out = placeFolios([folio({ id: "a" }), folio({ id: "b", folio_number: 2 })]);
    expect(out).toHaveLength(2);
    expect(out[0]!.id).toBe("a");
    expect(out[0]!.celestial.azimuth).toBeTypeOf("number");
    expect(out[1]!.id).toBe("b");
  });

  it("preserves input order", () => {
    const ids = ["a", "b", "c", "d"];
    const out = placeFolios(ids.map((id) => folio({ id, folio_number: id.charCodeAt(0) })));
    expect(out.map((f) => f.id)).toEqual(ids);
  });
});

describe("squaredDistance", () => {
  it("returns squared euclidean distance", () => {
    expect(squaredDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(25);
  });

  it("is zero for identical points", () => {
    expect(squaredDistance({ x: 7, y: -2 }, { x: 7, y: -2 })).toBe(0);
  });
});

describe("starMagnitude", () => {
  it("maps complete to bright", () => {
    expect(starMagnitude("complete")).toBe("bright");
  });

  it("maps failed to faint", () => {
    expect(starMagnitude("failed")).toBe("faint");
  });

  it("maps everything else (pending, streaming, unknown) to glimmer", () => {
    expect(starMagnitude("pending")).toBe("glimmer");
    expect(starMagnitude("streaming")).toBe("glimmer");
    expect(starMagnitude("anything")).toBe("glimmer");
  });
});
