import type { ResourceActionReconciliationScope } from "@/lib/actions/resourceActionSnapshotCache";
import type {
  LibraryPlacementDestinationKey,
  LibraryPlacementOption,
  LibraryPlacementTarget,
} from "@/lib/libraries/libraryPlacement";
import { libraryPlacementDestinationKey } from "@/lib/libraries/libraryPlacement";
import { canonicalResourceRef } from "@/lib/sharing/targets";

type CommittedLibraryPlacementReconciliation =
  | {
      readonly kind: "Ready";
      readonly placements: readonly LibraryPlacementOption[];
    }
  | { readonly kind: "ActionSnapshotFailed"; readonly error: unknown }
  | { readonly kind: "PlacementReadFailed"; readonly error: unknown };

export type UnconfirmedLibraryPlacementDecision =
  | { readonly kind: "Committed" }
  | { readonly kind: "RetryCommand" }
  | { readonly kind: "DestinationGone" };

/**
 * Decide an ambiguous write only from a fresh canonical placement inventory.
 * Add is satisfied by direct or inherited presence; Remove is satisfied once
 * the direct edge is absent, even when a parent Podcast still provides an
 * inherited edge. An unchanged direct-edge relation is safe to replay because
 * every placement command is idempotent.
 */
export function decideUnconfirmedLibraryPlacement(input: {
  readonly placements: readonly LibraryPlacementOption[];
  readonly destinationKey: LibraryPlacementDestinationKey;
  readonly op: "Add" | "Remove";
}): UnconfirmedLibraryPlacementDecision {
  const option = input.placements.find(
    ({ destination }) =>
      libraryPlacementDestinationKey(destination) === input.destinationKey,
  );
  if (!option) return { kind: "DestinationGone" };

  const committed =
    input.op === "Add"
      ? option.relation.kind !== "Absent"
      : option.relation.kind !== "Direct";
  return committed ? { kind: "Committed" } : { kind: "RetryCommand" };
}

function libraryPlacementCommitScope(
  target: LibraryPlacementTarget,
): ResourceActionReconciliationScope {
  return {
    kind: "Subjects",
    refs: [
      canonicalResourceRef({
        scheme: target.kind === "Media" ? "media" : "podcast",
        id: target.id,
      }),
    ],
  };
}

/**
 * Cross-system commit barrier: a successful placement command is not Ready
 * until the typed action snapshot has reconciled and placement truth has then
 * been read authoritatively. The order is part of the product contract.
 */
export async function reconcileCommittedLibraryPlacement(input: {
  readonly target: LibraryPlacementTarget;
  readonly onCommitted: (
    scope: ResourceActionReconciliationScope,
  ) => Promise<void>;
  readonly readPlacements: () => Promise<readonly LibraryPlacementOption[]>;
}): Promise<CommittedLibraryPlacementReconciliation> {
  try {
    await input.onCommitted(libraryPlacementCommitScope(input.target));
  } catch (error) {
    return { kind: "ActionSnapshotFailed", error };
  }
  try {
    return { kind: "Ready", placements: await input.readPlacements() };
  } catch (error) {
    return { kind: "PlacementReadFailed", error };
  }
}
