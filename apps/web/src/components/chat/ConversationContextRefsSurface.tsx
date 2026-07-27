"use client";

import { useRef, useState } from "react";
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import ItemCard from "@/components/items/ItemCard";
import ActionMenu from "@/components/ui/ActionMenu";
import {
  composeResourceMenu,
  projectResourceActionToMenu,
  resolveResourceCoreActions,
  RESOURCE_ACTION_CATALOG,
  type ResourceActionId,
} from "@/lib/actions/resourceActions";
import {
  isApiError,
  isSameSystemApiDefect,
} from "@/lib/api/client";
import { absent } from "@/lib/api/presence";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { requestWorkspaceTargetActivation } from "@/lib/workspace/workspaceTargetActivationIngress";
import type { ContextRefOut } from "@/lib/resourceGraph/contextRefs";
import {
  executeResourceChat,
  executeResourceOpen,
  executeResourceShare,
} from "@/lib/resources/resourceActionExecution";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import { resourceIconForUri } from "@/lib/resources/resourceKind";
import { useShareController } from "@/lib/sharing/controller";
import styles from "./ConversationContextRefsSurface.module.css";

export default function ConversationContextRefsSurface({
  contextRefs,
  removeContextRef,
  onOpenResource,
}: {
  contextRefs: ContextRefOut[];
  removeContextRef: (edgeId: string) => Promise<void>;
  onOpenResource: (contextRef: ContextRefOut) => void;
}) {
  if (contextRefs.length === 0) {
    return <p className={styles.empty}>No context yet.</p>;
  }
  return (
    <div className={styles.secondary}>
      {contextRefs.map((contextRef) => (
        <ContextRefRow
          key={contextRef.id}
          contextRef={contextRef}
          removeContextRef={removeContextRef}
          onOpenResource={onOpenResource}
        />
      ))}
    </div>
  );
}

function ContextRefRow({
  contextRef,
  removeContextRef,
  onOpenResource,
}: {
  contextRef: ContextRefOut;
  removeContextRef: (edgeId: string) => Promise<void>;
  onOpenResource: (contextRef: ContextRefOut) => void;
}) {
  const Icon = resourceIconForUri(contextRef.resource_ref);
  const { openShare } = useShareController();
  const busyRef = useRef<Set<ResourceActionId>>(new Set());
  const [busyIds, setBusyIds] = useState<ReadonlySet<ResourceActionId>>(
    () => new Set(),
  );
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);

  async function runAction({
    id,
    execute,
    failure,
  }: {
    id: ResourceActionId;
    execute: () => Promise<void>;
    failure: string;
  }) {
    if (busyRef.current.has(id)) return;
    busyRef.current.add(id);
    setBusyIds(new Set(busyRef.current));
    setFeedback(null);
    try {
      await execute();
    } catch (error) {
      if (handleUnauthenticatedApiError(error)) return;
      if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
      setFeedback(toFeedback(error, { fallback: failure }));
    } finally {
      busyRef.current.delete(id);
      setBusyIds(new Set(busyRef.current));
    }
  }

  const core = resolveResourceCoreActions({
    target: contextRef.actionTarget,
    projection: "Representation",
    busyIds,
    executors: {
      open: (subject: ResourceActionSubject) =>
        executeResourceOpen({
          target: subject,
          resourceNavigation: {
            labelHint: contextRef.label,
            activateTarget: () => onOpenResource(contextRef),
            disposition: { kind: "Follow" },
          },
        }),
      share: (subject, { triggerEl }) =>
        executeResourceShare({
          subject,
          openShare,
          options: {
            returnFocusTo: () => triggerEl,
            returnFocusFallback: absent(),
          },
        }),
      chat: (subject: ResourceActionSubject) =>
        runAction({
          id: RESOURCE_ACTION_CATALOG.Chat.id,
          execute: () =>
            executeResourceChat({
              ref: subject.ref,
              openConversation: (conversationId) => {
                requestWorkspaceTargetActivation({
                  target: {
                    href: `/conversations/${conversationId}`,
                    labelHint: "Chat",
                  },
                  disposition: { kind: "Adopt" },
                  modality: "Programmatic",
                });
              },
            }),
          failure: "Chat could not be started.",
        }),
    },
  });
  const remove = projectResourceActionToMenu({
    kind: "command",
    catalogKey: "RemoveFromContext",
    busy: busyIds.has(RESOURCE_ACTION_CATALOG.RemoveFromContext.id),
    onSelect: () => {
      void runAction({
        id: RESOURCE_ACTION_CATALOG.RemoveFromContext.id,
        execute: () => removeContextRef(contextRef.id),
        failure: "Context could not be removed.",
      });
    },
  });
  const options = composeResourceMenu({
    ...core,
    relationships: [remove],
  });

  return (
    <ItemCard
      unavailable={contextRef.missing}
      content={{
        kind: "resource",
        title: contextRef.label,
        icon: <Icon size={14} aria-hidden="true" />,
      }}
      meta={contextRef.summary || undefined}
      onActivate={() => onOpenResource(contextRef)}
      actions={
        <>
          <ActionMenu options={options} />
          {feedback ? <FeedbackNotice feedback={feedback} /> : null}
        </>
      }
    />
  );
}
