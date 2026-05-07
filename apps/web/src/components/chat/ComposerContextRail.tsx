"use client";

import type { ReactNode } from "react";
import { Book, FolderOpen, Globe } from "lucide-react";
import Chip from "@/components/ui/Chip";
import type { ContextItem, ContextItemColor } from "@/lib/api/sse";
import {
  formatConversationScopeLabel,
  getContextChipLabel,
} from "@/lib/conversations/display";
import type { ConversationScope } from "@/lib/conversations/types";
import styles from "./ComposerContextRail.module.css";

const SWATCH_CLASS = {
  yellow: styles.swatchYellow,
  green: styles.swatchGreen,
  blue: styles.swatchBlue,
  pink: styles.swatchPink,
  purple: styles.swatchPurple,
} satisfies Record<ContextItemColor, string>;

export default function ComposerContextRail({
  scope,
  attachedContexts,
  onClearScope,
  onRemoveContext,
}: {
  scope: ConversationScope;
  attachedContexts: ContextItem[];
  onClearScope?: () => void;
  onRemoveContext: (index: number) => void;
}) {
  const showScope = scope.type !== "general";
  const showContexts = attachedContexts.length > 0;

  if (!showScope && !showContexts) {
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
