import type { CelestialPosition } from "@/app/(authenticated)/atlas/projection";

/**
 * Prim's minimum spanning tree over a constellation's positioned members
 * (grand-atlas §7.3). Returns media-id pairs — the RAF loop re-projects each
 * pair to screen coordinates every frame, so the hairlines rotate with the
 * camera without re-running Prim's. O(N²), safe for N ≤ hundreds per library.
 */

export interface ConstellationMstInput {
  celestialPositions: Map<string, CelestialPosition>;
  memberMediaIds: string[];
}

/** Great-circle-ish weight on the dome: squared chord over (azimuth, altitude). */
function weight(a: CelestialPosition, b: CelestialPosition): number {
  const dAz = a.azimuth - b.azimuth;
  const dAlt = a.altitude - b.altitude;
  return dAz * dAz + dAlt * dAlt;
}

export function constellationMst(input: ConstellationMstInput): [string, string][] {
  const { celestialPositions, memberMediaIds } = input;
  // Only members with a real (non-Nebula) position participate.
  const nodes = memberMediaIds.filter((id) => celestialPositions.has(id));
  if (nodes.length < 2) return [];

  const inMst = new Set<string>([nodes[0]!]);
  const edges: [string, string][] = [];

  while (inMst.size < nodes.length) {
    let best: { from: string; to: string; w: number } | null = null;
    for (const from of inMst) {
      const fromPos = celestialPositions.get(from)!;
      for (const to of nodes) {
        if (inMst.has(to)) continue;
        const w = weight(fromPos, celestialPositions.get(to)!);
        if (best === null || w < best.w) {
          best = { from, to, w };
        }
      }
    }
    if (best === null) break; // unreachable while inMst < nodes, but keeps types total
    inMst.add(best.to);
    edges.push([best.from, best.to]);
  }
  return edges;
}
