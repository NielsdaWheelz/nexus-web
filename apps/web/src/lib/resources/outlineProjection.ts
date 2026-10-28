/** An outline is one branch through resource facts, not a deduplicated graph.
 * Traversed facts disappear; distinct facts reaching an ancestor stay terminal.
 * Root changes discard traversal history without changing stored relationships. */
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
