import { describe, expect, it } from "vitest";
import type { CelestialPosition } from "@/app/(authenticated)/atlas/projection";
import { constellationMst } from "./constellationMst";

function pos(azimuth: number, altitude: number): CelestialPosition {
  return { azimuth, altitude };
}

describe("constellationMst", () => {
  it("returns N-1 edges for N positioned members (a spanning tree)", () => {
    const positions = new Map<string, CelestialPosition>([
      ["a", pos(0, 0)],
      ["b", pos(0.1, 0)],
      ["c", pos(0.2, 0)],
    ]);
    const edges = constellationMst({
      celestialPositions: positions,
      memberMediaIds: ["a", "b", "c"],
    });
    expect(edges).toHaveLength(2);
  });

  it("connects the near neighbors, not the far chord (minimum weight)", () => {
    // A collinear triangle a-b-c: MST must be a-b and b-c, never a-c.
    const positions = new Map<string, CelestialPosition>([
      ["a", pos(0, 0)],
      ["b", pos(0.1, 0)],
      ["c", pos(0.2, 0)],
    ]);
    const edges = constellationMst({
      celestialPositions: positions,
      memberMediaIds: ["a", "b", "c"],
    });
    const asSet = edges.map(([x, y]) => [x, y].sort().join("-")).sort();
    expect(asSet).toEqual(["a-b", "b-c"]);
  });

  it("skips Nebula members with no celestial position", () => {
    const positions = new Map<string, CelestialPosition>([
      ["a", pos(0, 0)],
      ["b", pos(0.1, 0)],
    ]);
    const edges = constellationMst({
      celestialPositions: positions,
      memberMediaIds: ["a", "b", "nebula-1", "nebula-2"],
    });
    expect(edges).toEqual([["a", "b"]]);
  });

  it("returns no edges when fewer than two members are positioned", () => {
    const positions = new Map<string, CelestialPosition>([["a", pos(0, 0)]]);
    expect(
      constellationMst({ celestialPositions: positions, memberMediaIds: ["a", "b"] }),
    ).toEqual([]);
  });
});
