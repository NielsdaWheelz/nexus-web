"use client";

import ItemCard from "@/components/items/ItemCard";
import ActionMenu from "@/components/ui/ActionMenu";
import type { ContextRefOut } from "@/lib/resourceGraph/contextRefs";
import { resourceIconForUri } from "@/lib/resources/resourceKind";
import styles from "./ConversationReferencesSurface.module.css";

export default function ConversationReferencesSurface({
  references,
  removeReference,
  onOpenResource,
}: {
  references: ContextRefOut[];
  removeReference: (edgeId: string) => Promise<void>;
  onOpenResource?: (uri: string) => void;
}) {
  if (references.length === 0) {
    return <p className={styles.empty}>No references yet.</p>;
  }
  return (
    <div className={styles.secondary}>
      {references.map((reference) => {
        const Icon = resourceIconForUri(reference.resource_ref);
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
                ? () => onOpenResource(reference.resource_ref)
                : undefined
            }
            actions={
              <ActionMenu
                options={[
                  {
                    id: "open",
                    label: "Open",
                    disabled: !onOpenResource || reference.missing,
                    onSelect: () => onOpenResource?.(reference.resource_ref),
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
            }
          />
        );
      })}
    </div>
  );
}
