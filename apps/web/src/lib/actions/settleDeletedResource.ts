import { hasUncommittedWriting } from "@/lib/notes/runtime";
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
    "state" | "settleDeletedPanes"
  >;
  readonly deletedRef: string;
  readonly fallbackHref: string;
}): void {
  const { state, settleDeletedPanes } = input.workspace;
  // Collect first: each command commits, so a live projection would shift.
  const paneIds = state.panes
    .filter((pane) => {
      const { locator } = resolvePaneRouteModel(pane.current_visit.href);
      return locator?.kind === "resource_ref" && locator.ref === input.deletedRef;
    })
    .map((pane) => pane.id);
  if (hasUncommittedWriting()) return;
  settleDeletedPanes({
    paneIds,
    fallbackPaneId: paneIds.includes(state.active_primary_pane_id) ? state.active_primary_pane_id : null,
    fallbackHref: input.fallbackHref,
  });
}
