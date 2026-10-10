import { resolvePaneRouteModel } from "@/lib/panes/paneRouteModel";
import type { WorkspaceState } from "@/lib/workspace/model";
import type { CanonicalResourceRef } from "@/lib/sharing/types";

export interface DeletedResourceWorkspace {
  readonly state: WorkspaceState;
  readonly navigatePane: (
    paneId: string,
    href: string,
    options: {
      readonly replace: true;
      readonly activate: boolean;
    },
  ) => void;
  readonly closePane: (paneId: string) => void;
}

/**
 * Settle the workspace after a resource becomes unreadable. The active
 * deleted-resource pane adopts the owning collection; duplicate inactive panes
 * close. When deletion starts from an index or other resource, that active pane
 * stays put and every stale resource pane closes.
 */
export function settleDeletedResourcePanes(input: {
  readonly workspace: DeletedResourceWorkspace;
  readonly deletedRef: CanonicalResourceRef;
  readonly fallbackHref: string;
}): void {
  const state = input.workspace.state;
  // Materialize the matching panes before acting: navigatePane/closePane
  // commit to the store, so a live projection would shift under iteration.
  const matchingPaneIds = state.panes
    .filter((pane) => {
      const { locator } = resolvePaneRouteModel(pane.currentVisit.href);
      return (
        locator?.kind === "resource_ref" && locator.ref === input.deletedRef
      );
    })
    .map((pane) => pane.id);

  for (const paneId of matchingPaneIds) {
    if (paneId === state.activePrimaryPaneId) {
      input.workspace.navigatePane(paneId, input.fallbackHref, {
        replace: true,
        activate: true,
      });
    } else {
      input.workspace.closePane(paneId);
    }
  }
}
