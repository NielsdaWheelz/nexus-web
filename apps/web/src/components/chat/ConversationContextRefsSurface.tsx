"use client";

import ItemCard from "@/components/items/ItemCard";
import ContextEdgeMenu from "@/components/resources/ContextEdgeMenu";
import ResourceActionMenu from "@/components/resources/ResourceActionMenu";
import { type FeedbackContent } from "@/components/feedback/Feedback";
import {
  isApiError,
  isSameSystemApiDefect,
  type ApiError,
} from "@/lib/api/client";
import type { ContextRefOut } from "@/lib/resourceGraph/contextRefs";
import { resourceIconForUri } from "@/lib/resources/resourceKind";
import styles from "./ConversationContextRefsSurface.module.css";

function contextActionErrorMessage(error: ApiError, title: string): FeedbackContent {
  switch (error.code) {
    case "E_NETWORK":
      return {
        tone: "Danger",
        title: "It’s unclear whether this action completed.",
        message: "Check the result before trying again.",
        requestId: error.requestId,
      };
    case "E_INVALID_REQUEST":
    case "E_BAD_REQUEST":
    case "E_FORBIDDEN":
    case "E_NOT_FOUND":
      return { tone: "Danger", title, requestId: error.requestId };
    default:
      throw error;
  }
}

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
          {/* Canonical resource dropdown — Open/Share/Chat/… only. */}
          <ResourceActionMenu
            target={contextRef.actionTarget}
            label={`Actions for ${contextRef.label}`}
          />
          {/* Separate context-edge control (AC4): the remove-from-context edge
              command is not a resource action and publishes on its own trigger. */}
          <ContextEdgeMenu
            action="RemoveFromContext"
            label={`Remove ${contextRef.label} from context`}
            execute={() => removeContextRef(contextRef.id)}
            presentFailure={(error) => {
              if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
              return contextActionErrorMessage(
                error,
                "Context could not be removed.",
              );
            }}
          />
        </>
      }
    />
  );
}
