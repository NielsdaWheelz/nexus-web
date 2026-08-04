import type { PaneVisitId } from "@/lib/workspace/schema";
import type { BranchDraft } from "./types";

/**
 * The structured chat-draft identity. A new-chat destination is keyed by its
 * pane visit — never route text — so two independent new-chat visits get
 * distinct drafts (the global provisional `path:new` model is hard-cut). An
 * existing path or a branch reply keeps its own stable identity.
 *
 * `chatDraftKeyFor` is the sole key constructor; `serializeChatDraftKey` is the
 * sole serializer, used only by the `useChatDraft` storage adapter.
 */
export type ChatDraftKey =
  | { kind: "NewConversation"; visitId: PaneVisitId }
  | { kind: "Path"; targetId: string }
  | { kind: "BranchMessage"; parentMessageId: string }
  | {
      kind: "BranchSelection";
      parentMessageId: string;
      clientSelectionId: string;
    };

export type ChatDraftKeyTarget =
  | { kind: "NewConversation"; visitId: PaneVisitId }
  | { kind: "Path"; targetId: string }
  | { kind: "Branch"; branchDraft: BranchDraft };

export function chatDraftKeyFor(target: ChatDraftKeyTarget): ChatDraftKey {
  switch (target.kind) {
    case "NewConversation":
      return { kind: "NewConversation", visitId: target.visitId };
    case "Path":
      return { kind: "Path", targetId: target.targetId };
    case "Branch": {
      const { branchDraft } = target;
      if (branchDraft.anchor.kind === "assistant_selection") {
        return {
          kind: "BranchSelection",
          parentMessageId: branchDraft.parentMessageId,
          clientSelectionId: branchDraft.anchor.client_selection_id,
        };
      }
      return {
        kind: "BranchMessage",
        parentMessageId: branchDraft.parentMessageId,
      };
    }
  }
}

export function serializeChatDraftKey(key: ChatDraftKey): string {
  switch (key.kind) {
    case "NewConversation":
      return `new:${key.visitId}`;
    case "Path":
      return `path:${key.targetId}`;
    case "BranchMessage":
      return `branch:${key.parentMessageId}:message`;
    case "BranchSelection":
      return `branch:${key.parentMessageId}:selection:${key.clientSelectionId}`;
  }
}
