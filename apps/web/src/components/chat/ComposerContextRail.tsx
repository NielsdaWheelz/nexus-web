"use client";

import type { ReactNode } from "react";
import Chip from "@/components/ui/Chip";
import type { ContextItem, ContextItemColor } from "@/lib/api/sse/requests";
import { getContextChipLabel } from "@/lib/conversations/display";
import { getContextIdentityKey } from "@/lib/conversations/attachedContext";
import styles from "./ComposerContextRail.module.css";

const SWATCH_CLASS = {
  yellow: styles.swatchYellow,
  green: styles.swatchGreen,
  blue: styles.swatchBlue,
  pink: styles.swatchPink,
  purple: styles.swatchPurple,
} satisfies Record<ContextItemColor, string>;

export default function ComposerContextRail({
  attachedContexts,
  onRemoveContext,
}: {
  attachedContexts: ContextItem[];
  onRemoveContext: (index: number) => void;
}) {
  if (attachedContexts.length === 0) {
    return null;
  }

  return (
    <div className={styles.rail} aria-label="Conversation context">
      {attachedContexts.map((context, index) => (
        <Chip
          key={`${getContextIdentityKey(context)}-${index}`}
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

function contextSwatch(color: ContextItemColor | undefined): ReactNode {
  if (!color) {
    return undefined;
  }
  return <span className={`${styles.swatch} ${SWATCH_CLASS[color]}`} />;
}
