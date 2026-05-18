"use client";

import Chip from "@/components/ui/Chip";
import {
  CONVERSATION_SCOPE_ICONS,
  formatConversationScopeLabel,
} from "@/lib/conversations/display";
import type { ConversationScope } from "@/lib/conversations/types";

export default function ConversationScopeChip({
  scope,
  compact = false,
}: {
  scope: ConversationScope;
  compact?: boolean;
}) {
  const Icon = CONVERSATION_SCOPE_ICONS[scope.type];

  return (
    <Chip
      size={compact ? "sm" : "md"}
      leadingIcon={<Icon size={14} aria-hidden="true" />}
      truncate
    >
      {formatConversationScopeLabel(scope)}
    </Chip>
  );
}
