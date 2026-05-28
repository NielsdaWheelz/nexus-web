"use client";

import { FileText, Library, Quote, X } from "lucide-react";
import Button from "@/components/ui/Button";
import { usePinnedSources } from "@/lib/conversations/usePinnedSources";
import type { ConversationPinnedSourceKind } from "@/lib/conversations/types";
import styles from "./PinnedSourcesTray.module.css";

const ICONS = {
  media: FileText,
  library: Library,
  reader_selection: Quote,
} as const satisfies Record<ConversationPinnedSourceKind, typeof FileText>;

export default function PinnedSourcesTray({
  conversationId,
}: {
  conversationId: string | null;
}) {
  const { pinned, removePin } = usePinnedSources(conversationId);
  if (!conversationId || pinned.length === 0) return null;
  return (
    <div className={styles.tray} role="region" aria-label="Pinned sources">
      <span className={styles.label}>Sources</span>
      <ul className={styles.list}>
        {pinned.map((pin) => {
          const Icon = ICONS[pin.kind];
          return (
            <li key={pin.id} className={styles.item}>
              <Icon size={12} aria-hidden="true" />
              <span className={styles.title} title={pin.title}>
                {pin.title}
              </span>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label={`Remove pinned source ${pin.title}`}
                onClick={() => void removePin(pin.ordinal)}
              >
                <X size={12} aria-hidden="true" />
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
