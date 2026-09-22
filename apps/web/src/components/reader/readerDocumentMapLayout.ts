export type ReaderDocumentMapLane = "structure" | "evidence";

export interface ReaderDocumentMapLayoutPoint {
  id: string;
  lane: ReaderDocumentMapLane;
  y: number;
}

export interface ReaderDocumentMapHitGroup {
  id: string;
  lane: ReaderDocumentMapLane;
  memberIds: readonly string[];
  anchorY: number;
  hitTop: number;
  hitHeight: number;
}

export function layoutReaderDocumentMap({
  points,
  trackHeight,
  nominalHitHeight,
}: {
  points: readonly ReaderDocumentMapLayoutPoint[];
  trackHeight: number;
  nominalHitHeight: number;
}): readonly ReaderDocumentMapHitGroup[] {
  if (!Number.isFinite(trackHeight) || trackHeight < 0) {
    throw new Error("Reader map track height must be finite and nonnegative.");
  }
  if (!Number.isFinite(nominalHitHeight) || nominalHitHeight <= 0) {
    throw new Error("Reader map nominal hit height must be finite and positive.");
  }
  const ids = new Set<string>();
  for (const point of points) {
    if (!Number.isFinite(point.y) || point.y < 0 || point.y > trackHeight) {
      throw new Error("Reader map destinations must be within the measured track.");
    }
    if (ids.has(point.id)) {
      throw new Error("Reader map destination ids must be unique.");
    }
    ids.add(point.id);
  }
  if (trackHeight === 0) return [];

  const groups: ReaderDocumentMapHitGroup[] = [];
  const halfHeight = nominalHitHeight / 2;
  for (const lane of ["structure", "evidence"] as const) {
    const sorted = points.filter((point) => point.lane === lane).sort((left, right) =>
      left.y - right.y || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    );
    const laneGroups: { firstY: number; lastY: number; memberIds: string[] }[] = [];
    for (const point of sorted) {
      const previous = laneGroups.at(-1);
      if (previous && point.y - previous.firstY < nominalHitHeight) {
        previous.lastY = point.y;
        previous.memberIds.push(point.id);
      } else {
        laneGroups.push({ firstY: point.y, lastY: point.y, memberIds: [point.id] });
      }
    }
    for (const [index, group] of laneGroups.entries()) {
      const previous = laneGroups[index - 1];
      const next = laneGroups[index + 1];
      const anchorY = group.firstY + (group.lastY - group.firstY) / 2;
      const desiredTop = anchorY - halfHeight;
      const desiredBottom = anchorY + halfHeight;
      const hitTop = previous
        ? Math.max(desiredTop, previous.lastY + (group.firstY - previous.lastY) / 2)
        : desiredTop;
      const hitBottom = next
        ? Math.min(desiredBottom, group.lastY + (next.firstY - group.lastY) / 2)
        : desiredBottom;
      groups.push({
        id: JSON.stringify([lane, ...[...group.memberIds].sort()]),
        lane,
        memberIds: group.memberIds,
        anchorY,
        hitTop,
        hitHeight: hitBottom - hitTop,
      });
    }
  }
  return groups.sort((left, right) =>
    left.anchorY - right.anchorY || (left.lane === right.lane ? 0 : left.lane === "structure" ? -1 : 1),
  );
}
