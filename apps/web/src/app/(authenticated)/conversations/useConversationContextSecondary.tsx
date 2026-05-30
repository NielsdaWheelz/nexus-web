"use client";

import { useMemo, type ReactNode } from "react";
import ConversationReferencesSurface from "@/components/chat/ConversationReferencesSurface";
import { usePaneSecondary } from "@/components/workspace/PaneSecondary";
import type { ConversationReference } from "@/lib/conversations/types";
import styles from "./page.module.css";

export function useConversationContextSecondary({
  references,
  removeReference,
  onOpenResource,
  forksBody = null,
}: {
  references: ConversationReference[];
  removeReference: (referenceId: string) => Promise<void>;
  onOpenResource?: (uri: string) => void;
  forksBody?: ReactNode;
}) {
  const descriptor = useMemo(
    () => ({
      groupId: "conversation-context" as const,
      defaultSurfaceId: "conversation-references" as const,
      surfaces: [
        {
          id: "conversation-references" as const,
          body: (
            <div className={styles.chatSecondaryBody}>
              <ConversationReferencesSurface
                references={references}
                removeReference={removeReference}
                onOpenResource={onOpenResource}
              />
            </div>
          ),
        },
        ...(forksBody
          ? [
              {
                id: "conversation-forks" as const,
                body: <div className={styles.chatSecondaryBody}>{forksBody}</div>,
              },
            ]
          : []),
      ],
    }),
    [forksBody, onOpenResource, references, removeReference],
  );
  usePaneSecondary(descriptor);
}
