import type { BranchDraft } from "./types";

export type ChatDraftKeyTarget =
  | { kind: "path"; pathTargetId?: string | null }
  | { kind: "branch"; branchDraft: BranchDraft };

export function chatDraftKeyFor(target: ChatDraftKeyTarget): string {
  if (target.kind === "path") {
    return `path:${target.pathTargetId ?? "new"}`;
  }
  const draft = target.branchDraft;
  if (draft.anchor.kind === "assistant_selection") {
    return `branch:${draft.parentMessageId}:selection:${draft.anchor.client_selection_id}`;
  }
  return `branch:${draft.parentMessageId}:message`;
}
