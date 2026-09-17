import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import {
  getWorkspacePrimaryPanes,
  type WorkspaceState,
} from "@/lib/workspace/schema";
import type { CanonicalResourceRef } from "@/lib/sharing/types";

export interface DeletedResourceWorkspace {
  readonly state: WorkspaceState;
  readonly navigatePane: (
    paneId: string,
    href: string,
    options: {
      readonly replace: true;
      readonly activate: boolean;
      readonly modality: "Programmatic";
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
  // dispatch into the store, so a live projection would shift under iteration.
  const matchingPaneIds = getWorkspacePrimaryPanes(state)
    .filter((pane) => {
      const locator = resolvePaneRouteIdentity(
        pane.currentVisit.href,
      ).resourceLocator;
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
        modality: "Programmatic",
      });
    } else {
      input.workspace.closePane(paneId);
    }
  }
}

/**
 * Settle the owning Conversation after a committed Message delete. An
 * acknowledged receipt is authoritative; a lost receipt observes the parent
 * afresh. Index publication is synthesized only when the response-owning
 * client could not publish its acknowledged collection revision.
 */
export async function settleDeletedMessageConversation(input: {
  readonly conversationRef: CanonicalResourceRef;
  readonly messageEvidence: "Acknowledged" | "ObservedMissing";
  readonly receiptConversationDeleted: boolean | "Unknown";
  readonly observeConversationMissing: () => Promise<boolean>;
  readonly publishConversationIndexChange: () => void;
  readonly workspace: DeletedResourceWorkspace;
}): Promise<void> {
  if (input.messageEvidence === "ObservedMissing") {
    input.publishConversationIndexChange();
  }
  const conversationDeleted =
    input.receiptConversationDeleted === "Unknown"
      ? await input.observeConversationMissing()
      : input.receiptConversationDeleted;
  if (!conversationDeleted) return;
  settleDeletedResourcePanes({
    deletedRef: input.conversationRef,
    fallbackHref: "/conversations",
    workspace: input.workspace,
  });
}
