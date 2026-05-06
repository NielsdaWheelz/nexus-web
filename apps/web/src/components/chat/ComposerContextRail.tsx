"use client";

import type { ReactNode } from "react";
import { Book, FolderOpen, GitBranch, Globe } from "lucide-react";
import Chip from "@/components/ui/Chip";
import type { ContextItem, ContextItemColor } from "@/lib/api/sse";
import {
  formatConversationScopeLabel,
  getContextChipLabel,
  truncateText,
} from "@/lib/conversations/display";
import type { BranchDraft, ConversationScope } from "@/lib/conversations/types";
import styles from "./ComposerContextRail.module.css";

const SWATCH_CLASS = {
  yellow: styles.swatchYellow,
  green: styles.swatchGreen,
  blue: styles.swatchBlue,
  pink: styles.swatchPink,
  purple: styles.swatchPurple,
} satisfies Record<ContextItemColor, string>;

const BRANCH_PREVIEW_MAX = 60;

export default function ComposerContextRail({
  scope,
  branchDraft,
  attachedContexts,
  onClearScope,
  onClearBranchDraft,
  onRemoveContext,
}: {
  scope: ConversationScope;
  branchDraft: BranchDraft | null;
  attachedContexts: ContextItem[];
  onClearScope?: () => void;
  onClearBranchDraft: () => void;
  onRemoveContext: (index: number) => void;
}) {
  const showScope = scope.type !== "general";
  const showBranch = branchDraft !== null;
  const showContexts = attachedContexts.length > 0;

  if (!showScope && !showBranch && !showContexts) {
    return null;
  }

  return (
    <div className={styles.rail} aria-label="Conversation context">
      {showScope ? (
        <Chip
          truncate
          leadingIcon={scopeIcon(scope)}
          removable={Boolean(onClearScope)}
          onRemove={onClearScope}
        >
          {formatConversationScopeLabel(scope)}
        </Chip>
      ) : null}

      {branchDraft ? (
        <Chip
          truncate
          leadingIcon={<GitBranch size={14} aria-hidden="true" />}
          removable
          onRemove={onClearBranchDraft}
        >
          {truncateText(branchAnchorPreview(branchDraft), BRANCH_PREVIEW_MAX)}
        </Chip>
      ) : null}

      {attachedContexts.map((context, index) => (
        <Chip
          key={`${contextKey(context)}-${index}`}
          truncate
          leadingIcon={contextSwatch(context.color)}
          removable
          onRemove={() => onRemoveContext(index)}
        >
          {getContextChipLabel(context)}
        </Chip>
      ))}
    </div>
  );
}

function scopeIcon(scope: ConversationScope): ReactNode {
  if (scope.type === "general") {
    return <Globe size={14} aria-hidden="true" />;
  }
  if (scope.type === "media") {
    return <Book size={14} aria-hidden="true" />;
  }
  if (scope.type === "library") {
    return <FolderOpen size={14} aria-hidden="true" />;
  }
  const exhaustive: never = scope;
  return exhaustive;
}

function branchAnchorPreview(draft: BranchDraft): string {
  if (draft.anchor.kind === "assistant_selection") {
    return draft.anchor.exact;
  }
  return draft.parentMessagePreview;
}

function contextSwatch(color: ContextItemColor | undefined): ReactNode {
  if (!color) {
    return undefined;
  }
  return <span className={`${styles.swatch} ${SWATCH_CLASS[color]}`} />;
}

function contextKey(context: ContextItem): string {
  if (context.kind === "reader_selection") {
    return `reader_selection-${context.client_context_id}`;
  }
  return `${context.type}-${context.id}`;
}
