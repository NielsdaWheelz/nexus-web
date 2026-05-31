"use client";

import ItemCard from "@/components/items/ItemCard";
import type { ConversationReference } from "@/lib/conversations/types";
import { resourceIconForUri } from "@/lib/resources/resourceKind";
import styles from "./ConversationReferencesSurface.module.css";

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
        const Icon = resourceIconForUri(reference.resource_uri);
        return (
          <ItemCard
            key={reference.id}
            className={reference.missing ? styles.missing : undefined}
            content={{
              kind: "resource",
              title: reference.label,
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
