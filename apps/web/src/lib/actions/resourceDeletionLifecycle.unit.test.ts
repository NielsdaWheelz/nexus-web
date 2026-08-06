import { describe, expect, it, vi } from "vitest";

import {
  planDeletedResourcePaneEffects,
  settleDeletedMessageConversation,
} from "@/lib/actions/resourceDeletionLifecycle";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import {
  assumePaneVisitId,
  createWorkspaceStateFromPrimaryPanes,
  type WorkspacePrimaryPaneState,
} from "@/lib/workspace/schema";

const DELETED_REF = canonicalResourceRef({
  scheme: "conversation",
  id: "01988c00-91d0-7499-a0a6-b8798dc08c68",
});

function pane(
  id: string,
  href: string,
  visitId: string,
): WorkspacePrimaryPaneState {
  return {
    id,
    currentVisit: { id: assumePaneVisitId(visitId), href },
    primaryWidthPx: 720,
    visibility: "visible",
    history: { back: [], forward: [] },
    attachedSecondaryPaneId: null,
  };
}

const MATCHING_ONE = pane(
  "chat-one",
  "/conversations/01988c00-91d0-7499-a0a6-b8798dc08c68",
  "00000000-0000-4000-8000-000000000001",
);
const MATCHING_TWO = pane(
  "chat-two",
  "/conversations/01988c00-91d0-7499-a0a6-b8798dc08c68?find=truth",
  "00000000-0000-4000-8000-000000000002",
);
const INDEX = pane(
  "index",
  "/conversations",
  "00000000-0000-4000-8000-000000000003",
);

describe("deleted resource pane settlement", () => {
  it("replaces the active deleted-resource pane and closes its duplicates", () => {
    const state = createWorkspaceStateFromPrimaryPanes({
      primaryPanes: [MATCHING_ONE, INDEX, MATCHING_TWO],
      activePrimaryPaneId: MATCHING_ONE.id,
    });

    expect(
      planDeletedResourcePaneEffects({
        state,
        deletedRef: DELETED_REF,
        fallbackHref: "/conversations",
      }),
    ).toEqual([
      { kind: "Replace", paneId: MATCHING_ONE.id, href: "/conversations" },
      { kind: "Close", paneId: MATCHING_TWO.id },
    ]);
  });

  it("keeps an active index in place and closes every stale resource pane", () => {
    const state = createWorkspaceStateFromPrimaryPanes({
      primaryPanes: [MATCHING_ONE, INDEX, MATCHING_TWO],
      activePrimaryPaneId: INDEX.id,
    });

    expect(
      planDeletedResourcePaneEffects({
        state,
        deletedRef: DELETED_REF,
        fallbackHref: "/conversations",
      }),
    ).toEqual([
      { kind: "Close", paneId: MATCHING_ONE.id },
      { kind: "Close", paneId: MATCHING_TWO.id },
    ]);
  });

  it("does nothing when no pane routes to the deleted resource", () => {
    const state = createWorkspaceStateFromPrimaryPanes({
      primaryPanes: [INDEX],
      activePrimaryPaneId: INDEX.id,
    });

    expect(
      planDeletedResourcePaneEffects({
        state,
        deletedRef: DELETED_REF,
        fallbackHref: "/conversations",
      }),
    ).toEqual([]);
  });

  it("trusts an acknowledged cascade receipt without observing or republishing", async () => {
    const state = createWorkspaceStateFromPrimaryPanes({
      primaryPanes: [MATCHING_ONE, INDEX, MATCHING_TWO],
      activePrimaryPaneId: MATCHING_ONE.id,
    });
    const navigatePane = vi.fn();
    const closePane = vi.fn();
    const observeConversationMissing = vi.fn();
    const publishConversationIndexChange = vi.fn();

    await settleDeletedMessageConversation({
      conversationRef: DELETED_REF,
      messageEvidence: "Acknowledged",
      receiptConversationDeleted: true,
      observeConversationMissing,
      publishConversationIndexChange,
      workspace: { state, navigatePane, closePane },
    });

    expect(observeConversationMissing).not.toHaveBeenCalled();
    expect(publishConversationIndexChange).not.toHaveBeenCalled();
    expect(navigatePane).toHaveBeenCalledOnce();
    expect(closePane).toHaveBeenCalledOnce();
  });

  it("publishes then observes a lost receipt and keeps a present Conversation pane", async () => {
    const state = createWorkspaceStateFromPrimaryPanes({
      primaryPanes: [MATCHING_ONE],
      activePrimaryPaneId: MATCHING_ONE.id,
    });
    const navigatePane = vi.fn();
    const closePane = vi.fn();
    const observeConversationMissing = vi.fn().mockResolvedValue(false);
    const publishConversationIndexChange = vi.fn();

    await settleDeletedMessageConversation({
      conversationRef: DELETED_REF,
      messageEvidence: "ObservedMissing",
      receiptConversationDeleted: "Unknown",
      observeConversationMissing,
      publishConversationIndexChange,
      workspace: { state, navigatePane, closePane },
    });

    expect(publishConversationIndexChange).toHaveBeenCalledOnce();
    expect(observeConversationMissing).toHaveBeenCalledOnce();
    expect(navigatePane).not.toHaveBeenCalled();
    expect(closePane).not.toHaveBeenCalled();
  });
});
