"use client";

import { useEffect, useState } from "react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import ItemCard from "@/components/items/ItemCard";
import ContextEdgeMenu from "@/components/resources/ContextEdgeMenu";
import ResourceActionMenu from "@/components/resources/ResourceActionMenu";
import { useResource } from "@/lib/api/useResource";
import { chatFailure } from "@/lib/chat/wire";
import {
  listContextRefs,
  removeContextRef,
  type ContextRefOut,
} from "@/lib/resourceGraph/contextRefs";
import { resourceIconForUri } from "@/lib/resources/resourceKind";
import styles from "./ChatPanels.module.css";

/**
 * The inspector's Context tab. It re-reads when a saved answer settles (its
 * citation refs commit with it) and after a remove; the last list stays shown.
 */
export default function ContextRefsPanel({
  conversationId,
  version,
  onOpen,
}: {
  conversationId: string;
  version: number;
  onOpen(ref: ContextRefOut): void;
}) {
  const [removed, setRemoved] = useState(0);
  const refs = useResource<ContextRefOut[]>({
    cacheKey: `chat-context:${conversationId}:${version}:${removed}`,
    load: (signal) => listContextRefs(conversationId, { signal }),
  });
  const [shown, setShown] = useState<ContextRefOut[] | null>(null);
  useEffect(() => {
    if (refs.status === "ready") setShown(refs.data);
  }, [refs]);
  if (refs.status === "error" && shown === null)
    return (
      <FeedbackNotice
        content={{
          tone: "Danger",
          title: "Context couldn’t be loaded.",
          requestId: refs.error.requestId,
        }}
        announcement="None"
        actions={[{ label: "Retry", onClick: refs.retry }]}
      />
    );
  if (shown === null)
    return <p className={styles.panelEmpty}>Loading context…</p>;
  if (shown.length === 0)
    return <p className={styles.panelEmpty}>No context yet.</p>;
  return (
    <div className={styles.context}>
      {shown.map((ref) => {
        const Icon = resourceIconForUri(ref.resource_ref);
        return (
          <ItemCard
            key={ref.id}
            unavailable={ref.missing}
            content={{
              title: ref.label,
              icon: <Icon size={14} aria-hidden="true" />,
            }}
            meta={ref.summary || undefined}
            onActivate={() => onOpen(ref)}
            actions={
              <>
                <ResourceActionMenu
                  actionSubject={ref.actionSubject}
                  label={`Actions for ${ref.label}`}
                />
                <ContextEdgeMenu
                  action="RemoveFromContext"
                  label={`Remove ${ref.label} from context`}
                  execute={async () => {
                    await removeContextRef(conversationId, ref.id);
                    setRemoved((value) => value + 1);
                  }}
                  presentFailure={(error) => {
                    const failure = chatFailure(
                      error,
                      "Context could not be removed.",
                    );
                    if (failure.kind !== "Feedback") throw error;
                    return failure.feedback;
                  }}
                />
              </>
            }
          />
        );
      })}
    </div>
  );
}
