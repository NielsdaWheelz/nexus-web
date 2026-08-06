import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import {
  getWorkspacePrimaryPanes,
  type WorkspaceState,
} from "@/lib/workspace/schema";
import type { CanonicalResourceRef } from "@/lib/sharing/types";

export type DeletedResourcePaneEffect =
  | {
      readonly kind: "Replace";
      readonly paneId: string;
      readonly href: string;
    }
  | { readonly kind: "Close"; readonly paneId: string };

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
 * Plan the deterministic workspace settlement after a resource becomes
 * unreadable. The active deleted-resource pane adopts the owning collection;
 * duplicate inactive panes close. When deletion starts from an index or other
 * resource, that active pane stays put and every stale resource pane closes.
 */
export function planDeletedResourcePaneEffects(input: {
  readonly state: WorkspaceState;
  readonly deletedRef: CanonicalResourceRef;
  readonly fallbackHref: string;
}): readonly DeletedResourcePaneEffect[] {
  const matchingPaneIds = getWorkspacePrimaryPanes(input.state)
    .filter((pane) => {
      const locator = resolvePaneRouteIdentity(
        pane.currentVisit.href,
      ).resourceLocator;
      return (
        locator?.kind === "resource_ref" && locator.ref === input.deletedRef
      );
    })
    .map((pane) => pane.id);
  if (matchingPaneIds.length === 0) return [];

  const activeMatches = matchingPaneIds.includes(
    input.state.activePrimaryPaneId,
  );
  return matchingPaneIds.map((paneId) =>
    activeMatches && paneId === input.state.activePrimaryPaneId
      ? {
          kind: "Replace" as const,
          paneId,
          href: input.fallbackHref,
        }
      : { kind: "Close" as const, paneId },
  );
}

/** Execute the pure settlement plan against the latest workspace snapshot. */
export function settleDeletedResourcePanes(input: {
  readonly workspace: DeletedResourceWorkspace;
  readonly deletedRef: CanonicalResourceRef;
  readonly fallbackHref: string;
}): void {
  const effects = planDeletedResourcePaneEffects({
    state: input.workspace.state,
    deletedRef: input.deletedRef,
    fallbackHref: input.fallbackHref,
  });
  for (const effect of effects) {
    switch (effect.kind) {
      case "Replace":
        input.workspace.navigatePane(effect.paneId, effect.href, {
          replace: true,
          activate: effect.paneId === input.workspace.state.activePrimaryPaneId,
          modality: "Programmatic",
        });
        break;
      case "Close":
        input.workspace.closePane(effect.paneId);
        break;
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
