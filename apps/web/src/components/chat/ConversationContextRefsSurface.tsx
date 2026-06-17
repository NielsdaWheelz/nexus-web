"use client";

import ItemCard from "@/components/items/ItemCard";
import ActionMenu from "@/components/ui/ActionMenu";
import type { ContextRefOut } from "@/lib/resourceGraph/contextRefs";
import { resourceIconForUri } from "@/lib/resources/resourceKind";
import styles from "./ConversationContextRefsSurface.module.css";

export default function ConversationContextRefsSurface({
  contextRefs,
  removeContextRef,
  onOpenResource,
}: {
  contextRefs: ContextRefOut[];
  removeContextRef: (edgeId: string) => Promise<void>;
  onOpenResource?: (contextRef: ContextRefOut) => void;
}) {
  if (contextRefs.length === 0) {
    return <p className={styles.empty}>No context yet.</p>;
  }
  return (
    <div className={styles.secondary}>
      {contextRefs.map((contextRef) => {
        const Icon = resourceIconForUri(contextRef.resource_ref);
        return (
          <ItemCard
            key={contextRef.id}
            className={contextRef.missing ? styles.missing : undefined}
            content={{
              kind: "resource",
              title: contextRef.label,
              icon: <Icon size={14} aria-hidden="true" />,
            }}
            meta={contextRef.summary || undefined}
            onActivate={
              onOpenResource && !contextRef.missing
                ? () => onOpenResource(contextRef)
                : undefined
            }
            actions={
              <ActionMenu
                options={[
                  {
                    id: "open",
                    label: "Open",
                    disabled: !onOpenResource || contextRef.missing,
                    onSelect: () => onOpenResource?.(contextRef),
                  },
                  {
                    id: "remove",
                    label: "Remove",
                    tone: "danger",
                    separatorBefore: true,
                    onSelect: () => {
                      void removeContextRef(contextRef.id);
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
