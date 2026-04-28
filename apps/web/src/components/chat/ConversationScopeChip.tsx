"use client";

import type { ReactNode } from "react";
import { BookOpen, FileText, MessageSquare } from "lucide-react";
import { formatConversationScopeLabel } from "@/lib/conversations/display";
import type { ConversationScope } from "@/lib/conversations/types";
import styles from "./ConversationScopeChip.module.css";

export default function ConversationScopeChip({
  scope,
  compact = false,
}: {
  scope: ConversationScope;
  compact?: boolean;
}) {
  let icon: ReactNode;
  if (scope.type === "general") {
    icon = <MessageSquare size={14} aria-hidden="true" />;
  } else if (scope.type === "media") {
    icon = <FileText size={14} aria-hidden="true" />;
  } else if (scope.type === "library") {
    icon = <BookOpen size={14} aria-hidden="true" />;
  } else {
    const exhaustive: never = scope;
    return exhaustive;
  }

  return (
    <span className={styles.scopeChip} data-compact={compact ? "true" : "false"}>
      {icon}
      <span className={styles.scopeText}>{formatConversationScopeLabel(scope)}</span>
    </span>
  );
}
