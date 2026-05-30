"use client";

import {
  AlignLeft,
  File,
  FileText,
  Highlighter,
  Library,
  Link2,
  MessageSquare,
  MessagesSquare,
  StickyNote,
  TextQuote,
  type LucideIcon,
} from "lucide-react";
import ItemCard from "@/components/items/ItemCard";
import type { ConversationReference } from "@/lib/conversations/types";
import styles from "./ConversationReferencesSurface.module.css";

const SCHEME_ICONS: Record<string, LucideIcon> = {
  media: FileText,
  library: Library,
  span: TextQuote,
  chunk: AlignLeft,
  highlight: Highlighter,
  page: File,
  note_block: StickyNote,
  fragment: TextQuote,
  conversation: MessagesSquare,
  message: MessageSquare,
};

export default function ConversationReferencesSurface({
  references,
  removeReference,
  onOpenResource,
}: {
  references: ConversationReference[];
  removeReference: (referenceId: string) => Promise<void>;
  onOpenResource?: (uri: string) => void;
}) {
  if (references.length === 0) {
    return <p className={styles.empty}>No references yet.</p>;
  }
  return (
    <div className={styles.secondary}>
      {references.map((reference) => {
        const Icon = SCHEME_ICONS[reference.resource_uri.split(":")[0]] ?? Link2;
        return (
          <ItemCard
            key={reference.id}
            className={reference.missing ? styles.missing : undefined}
            content={{
              kind: "resource",
              title: reference.missing
                ? `${reference.label} (unavailable)`
                : reference.label,
              icon: <Icon size={14} aria-hidden="true" />,
            }}
            meta={reference.summary || undefined}
            onActivate={
              onOpenResource && !reference.missing
                ? () => onOpenResource(reference.resource_uri)
                : undefined
            }
            actions={[
              {
                id: "open",
                label: "Open",
                disabled: !onOpenResource || reference.missing,
                onSelect: () => onOpenResource?.(reference.resource_uri),
              },
              {
                id: "remove",
                label: "Remove",
                tone: "danger",
                separatorBefore: true,
                onSelect: () => {
                  void removeReference(reference.id);
                },
              },
            ]}
          />
        );
      })}
    </div>
  );
}
