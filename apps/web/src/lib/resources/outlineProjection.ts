/** An outline is one branch through resource facts, not a deduplicated graph.
 * Traversed facts disappear; distinct facts reaching an ancestor stay terminal.
 * Root changes discard traversal history without changing stored relationships. */
import type { Schema } from "@/lib/api/wire";

/** Rendering and availability exclude the same exact facts. The containing-note
 * rule applies only to the primary endpoint, never its separate passage owner. */
export function outlineChildExclusions({
  resourceRef, branch, links, suppressedEdgeIds, removedEdgeIds, embeddedInNoteRef,
}: {
  resourceRef: string;
  branch: OutlineBranch;
  links: readonly { link_id: string; connection: Schema<"ConnectionOut"> | null }[];
  suppressedEdgeIds: readonly string[];
  removedEdgeIds: ReadonlySet<string>;
  embeddedInNoteRef: string | null;
}): string[] {
  const excluded = new Set([...branch.traversedEdgeIds, ...suppressedEdgeIds, ...removedEdgeIds]);
  for (const link of links) {
    const connection = link.connection;
    if (embeddedInNoteRef !== null && connection?.origin === "note_body" &&
        connection.kind === "context" && connection.ordinal === null &&
        connection.source.ref === embeddedInNoteRef && connection.target.ref === resourceRef)
      excluded.add(link.link_id);
  }
  return [...excluded].sort();
}

export type OutlineTarget = { kind: "root" } | { kind: "occurrence"; key: string };
export type OutlineBranch = {
  ancestors: ReadonlyMap<string, OutlineTarget>;
  traversedEdgeIds: ReadonlySet<string>;
};
export type OutlineProjection =
  | { kind: "omit" }
  | { kind: "resource" }
  | { kind: "reference"; target: OutlineTarget };

export function classifyOutlineOccurrence({ branch, targetRef, edgeId }: {
  branch: OutlineBranch;
  targetRef: string;
  edgeId: string | null;
}): OutlineProjection {
  if (edgeId !== null && branch.traversedEdgeIds.has(edgeId)) return { kind: "omit" };
  const target = branch.ancestors.get(targetRef);
  return target === undefined ? { kind: "resource" } : { kind: "reference", target };
}

export function enterOutlineOccurrence({ branch, ref, target, edgeIds }: {
  branch: OutlineBranch;
  ref: string;
  target: OutlineTarget;
  edgeIds: readonly string[];
}): OutlineBranch {
  return {
    ancestors: new Map(branch.ancestors).set(ref, target),
    traversedEdgeIds: new Set([...branch.traversedEdgeIds, ...edgeIds]),
  };
}
