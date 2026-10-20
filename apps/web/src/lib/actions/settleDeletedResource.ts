import { hasUnsavedOutline } from "@/lib/notes/useOutlineSession";
import { resolvePaneRouteModel } from "@/lib/panes/paneRouteModel";
import type { WorkspaceStoreValue } from "@/lib/workspace/store";

/**
 * Settle the workspace after a resource is deleted: the active pane showing it
 * adopts `fallbackHref` (its owning collection); other panes showing it close.
 * A deletion started from an index leaves that index pane where it is.
 */
export function settleDeletedResourcePanes(input: {
  readonly workspace: Pick<
    WorkspaceStoreValue,
    "state" | "navigatePane" | "closePane"
  >;
  readonly deletedRef: string;
  readonly fallbackHref: string;
}): void {
  const { state, navigatePane, closePane } = input.workspace;
  // Collect first: each command commits, so a live projection would shift.
  const paneIds = state.panes
    .filter((pane) => {
      const { locator } = resolvePaneRouteModel(pane.current_visit.href);
      return locator?.kind === "resource_ref" && locator.ref === input.deletedRef;
    })
    .map((pane) => pane.id);
  if (hasUnsavedOutline(input.deletedRef)) return;
  for (const paneId of paneIds) {
    if (paneId === state.active_primary_pane_id)
      navigatePane(paneId, input.fallbackHref, { replace: true, activate: true });
    else closePane(paneId);
  }
}
