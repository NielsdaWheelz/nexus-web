// Passage identity ignores quote text and PDF quad order. Geometry capture keeps
// source order for measuring native endpoints; comparison sorts copies only.
import type { MarkAnchor } from "./DocumentReader";
import type { PdfQuad } from "./model";

export function sameAnchor(a: MarkAnchor, b: MarkAnchor): boolean {
  if (a.kind === "text") return b.kind === "text" && a.unit === b.unit && a.start === b.start && a.end === b.end;
  if (b.kind !== "pdf" || a.page !== b.page || a.quads.length !== b.quads.length) return false;
  const ordered = (quads: readonly PdfQuad[]) => [...quads].sort((left, right) =>
    left.y1 - right.y1 || left.x1 - right.x1 || left.y3 - right.y3 || left.x2 - right.x2 ||
    left.y2 - right.y2 || left.x3 - right.x3 || left.x4 - right.x4 || left.y4 - right.y4,
  );
  const right = ordered(b.quads);
  return ordered(a.quads).every((quad, index) => {
    const other = right[index];
    return quad.x1 === other.x1 && quad.y1 === other.y1 && quad.x2 === other.x2 && quad.y2 === other.y2 &&
      quad.x3 === other.x3 && quad.y3 === other.y3 && quad.x4 === other.x4 && quad.y4 === other.y4;
  });
}
