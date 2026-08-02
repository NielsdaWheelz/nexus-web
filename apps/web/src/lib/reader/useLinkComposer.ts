"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import {
  useFeedback,
  type FeedbackActions,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import {
  isApiError,
  isSameSystemApiDefect,
} from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { createRandomId } from "@/lib/createRandomId";
import { createLink, deleteLink } from "@/lib/resourceGraph/links";
import type { LinkSource, LinkTarget } from "@/lib/resourceGraph/links";

type LinkMutation = "Create" | "Undo";

function isUndoOutcomeUnknown(error: unknown): boolean {
  return (
    isApiError(error) &&
    !isSameSystemApiDefect(error) &&
    (error.code === "E_NETWORK" || error.code === "E_UPSTREAM_TIMEOUT")
  );
}

/** Endpoint-owned finite adapter; unknown codes and defects stay defects. */
function linkErrorMessage(error: unknown, mutation: LinkMutation): FeedbackContent {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;

  const requestId = error.requestId;
  const title = mutation === "Create" ? "Link wasn’t created" : "Link wasn’t removed";
  switch (error.code) {
    case "E_NETWORK":
      if (mutation === "Create") {
        return {
          tone: "Warning",
          title: "Link outcome not confirmed",
          message:
            "The request may have completed. Retry replays the same Link request safely.",
          requestId,
        };
      }
      return {
        tone: "Danger",
        title,
        message: "A network problem interrupted the change. Retry when you’re connected.",
        requestId,
      };
    case "E_UPSTREAM_TIMEOUT":
      if (mutation === "Create") {
        return {
          tone: "Warning",
          title: "Link outcome not confirmed",
          message:
            "The request may have completed. Retry replays the same Link request safely.",
          requestId,
        };
      }
      return {
        tone: "Danger",
        title,
        message: "The server took too long to respond. Retry the change.",
        requestId,
      };
    case "E_NOT_FOUND":
      return {
        tone: "Danger",
        title,
        message:
          mutation === "Create"
            ? "The source or target is no longer available. Choose another target."
            : "This link is no longer available.",
        requestId,
      };
    case "E_FORBIDDEN":
      if (mutation !== "Undo") throw error;
      return {
        tone: "Danger",
        title,
        message: "This link can’t be removed from this account.",
        requestId,
      };
    case "E_INVALID_REQUEST":
      if (mutation !== "Create") throw error;
      return {
        tone: "Danger",
        title,
        message: "This selection or target can’t be linked. Choose another target.",
        requestId,
      };
    case "E_LINK_SELF":
      if (mutation !== "Create") throw error;
      return {
        tone: "Danger",
        title,
        message: "An item can’t be linked to itself. Choose another target.",
        requestId,
      };
    case "E_LINK_CAPABILITY":
      if (mutation !== "Create") throw error;
      return {
        tone: "Danger",
        title,
        message: "This source or target doesn’t support links. Choose another target.",
        requestId,
      };
    case "E_LINK_TARGET_AMBIGUOUS":
      if (mutation !== "Create") throw error;
      return {
        tone: "Danger",
        title,
        message: "That passage matches more than once. Choose a more specific target.",
        requestId,
      };
    case "E_LINK_TARGET_STALE":
      if (mutation !== "Create") throw error;
      return {
        tone: "Danger",
        title,
        message: "That passage changed. Search for it again, then retry.",
        requestId,
      };
    case "E_HIGHLIGHT_CONFLICT":
      if (mutation !== "Create") throw error;
      return {
        tone: "Danger",
        title,
        message: "The selected passage changed. Close Link, select the passage again, and retry.",
        requestId,
      };
    case "E_IDEMPOTENCY_KEY_REPLAY_MISMATCH":
      if (mutation !== "Create") throw error;
      return {
        tone: "Danger",
        title,
        message: "The link request changed. Close Link, then try again.",
        requestId,
      };
    default:
      throw error;
  }
}

export interface LinkComposerFailure {
  content: FeedbackContent;
  actions: FeedbackActions;
}

/**
 * The reader Link session (§ Target Behavior / Reader). Opening a Link performs
 * ZERO writes: the raw selection source (client-minted `highlight_id`) is held
 * until the user confirms a target, and only then does one `createLink` call
 * create the Highlight, materialize/reuse the passage anchor, and canonicalize
 * the Link atomically server-side (invariant 6). Cancel writes nothing.
 *
 * A fresh selection carries a `fragment_selection`/`pdf_selection` source; an
 * existing Highlight carries a `resource` source (`highlight:<id>`) and its
 * `sourceRef` for already-linked dedupe in the dialog. On success the toast
 * offers Undo — which deletes only the Link and keeps the authored Highlight
 * (invariant 8) — and, optionally, "Add note to link". A duplicate/reverse
 * target returns `created=false` ("Already linked · View connection") with no
 * Undo. Failure keeps the dialog/selection open with a Retry.
 */
export interface LinkComposer {
  open: boolean;
  /** Durable ResourceRef of the source Resource/Highlight, for dialog dedupe;
   * omitted for a fresh selection that has no Highlight yet. */
  sourceRef: string | undefined;
  committing: boolean;
  /** Create failure stays inside the open Link surface with its exact Retry. */
  failure: LinkComposerFailure | null;
  openLink: (args: { source: LinkSource; sourceRef?: string }) => void;
  close: () => void;
  /** `label` is the picked target's own display label — the confirmation toast
   * names it directly, because a canonically-reordered pair loses which server
   * endpoint was the target and the response can't say. */
  confirm: (target: LinkTarget, label: string) => Promise<void>;
}

export function useLinkComposer({
  onLinked,
  onAddLinkNote,
  onViewConnection,
}: {
  /** Refresh the reader-connections read model so the new Link appears. */
  onLinked: () => void;
  /** Open the Link-note composer for the just-created Link (toast action). */
  onAddLinkNote?: (linkId: string) => void;
  /** Reveal the Connection for an already-linked target (toast action). */
  onViewConnection?: () => void;
}): LinkComposer {
  const feedback = useFeedback();
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<LinkSource | null>(null);
  const [sourceRef, setSourceRef] = useState<string | undefined>(undefined);
  const [committing, setCommitting] = useState(false);
  const [failure, setFailure] = useState<LinkComposerFailure | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const commitGuardRef = useRef(false);

  const openLink = useCallback(
    (args: { source: LinkSource; sourceRef?: string }) => {
      setSource(args.source);
      setSourceRef(args.sourceRef);
      setFailure(null);
      setOpen(true);
    },
    [],
  );

  const close = useCallback(() => {
    setOpen(false);
    setSource(null);
    setSourceRef(undefined);
    setFailure(null);
  }, []);

  const undo = useCallback(
    async (linkId: string) => {
      const feedbackKey = `reader-link-undo:${linkId}`;
      try {
        await deleteLink(linkId);
        feedback.resolve(feedbackKey);
        onLinked();
      } catch (error) {
        if (handleUnauthenticatedApiError(error)) return;
        if (
          isApiError(error) &&
          !isSameSystemApiDefect(error) &&
          error.code === "E_NOT_FOUND"
        ) {
          feedback.resolve(feedbackKey);
          onLinked();
          return;
        }
        try {
          if (isUndoOutcomeUnknown(error)) {
            feedback.publish({
              kind: "Persistent",
              key: feedbackKey,
              // Polite: an unconfirmed removal loses no data and does not block
              // the current action; it persists on the rail with Retry.
              announcement: "Polite",
              content: {
                tone: "Warning",
                title: "Removal outcome not confirmed",
                message:
                  "Check Connections before trying again. Retry repeats the same Link removal.",
                requestId: isApiError(error) ? error.requestId : undefined,
              },
              actions: [
                { label: "Retry", onClick: () => void undo(linkId) },
              ],
            });
            return;
          }
          // A permanent undo failure (E_FORBIDDEN) cannot be retried and needs
          // no durable rail: the link simply stays, and the Connections surface
          // remains the durable place to manage it. Present it as a
          // harmless-to-miss HUD rather than an actionless, never-resolved
          // persistent record that could never be dismissed.
          feedback.publish({
            kind: "Hud",
            key: feedbackKey,
            content: linkErrorMessage(error, "Undo"),
          });
        } catch (caughtDefect) {
          setDefect({ error: caughtDefect });
        }
      }
    },
    [feedback, onLinked],
  );

  const confirm = useCallback(
    async (target: LinkTarget, label: string) => {
      if (!source || committing || commitGuardRef.current) return;
      const intent = {
        clientMutationId: createRandomId("link"),
        source,
        target,
        label,
      };

      async function runConfirmedIntent() {
        if (commitGuardRef.current) return;
        commitGuardRef.current = true;
        setCommitting(true);
        setFailure(null);
        try {
          const result = await createLink({
            clientMutationId: intent.clientMutationId,
            source: intent.source,
            target: intent.target,
          });
          onLinked();
          setOpen(false);
          setSource(null);
          setSourceRef(undefined);

          if (result.created) {
            const linkId = result.connection.edge_id;
            feedback.publish({
              kind: "Hud",
              content: {
                tone: "Success",
                title: `Linked to ${intent.label}`,
              },
              actions: onAddLinkNote
                ? [
                    { label: "Undo", onClick: () => void undo(linkId) },
                    {
                      label: "Add note to link",
                      onClick: () => onAddLinkNote(linkId),
                    },
                  ]
                : [{ label: "Undo", onClick: () => void undo(linkId) }],
            });
          } else {
            feedback.publish({
              kind: "Hud",
              content: {
                tone: "Info",
                title: `Already linked to ${intent.label}`,
              },
              actions: onViewConnection
                ? [{ label: "View connection", onClick: onViewConnection }]
                : undefined,
            });
          }
        } catch (error) {
          if (handleUnauthenticatedApiError(error)) return;
          // Keep the dialog and frozen intent open; Retry reuses its mutation id.
          try {
            setFailure({
              content: linkErrorMessage(error, "Create"),
              actions: [
                {
                  label: "Retry",
                  onClick: () => void runConfirmedIntent(),
                },
              ],
            });
          } catch (caughtDefect) {
            setDefect({ error: caughtDefect });
          }
        } finally {
          commitGuardRef.current = false;
          setCommitting(false);
        }
      }

      await runConfirmedIntent();
    },
    [committing, feedback, onAddLinkNote, onLinked, onViewConnection, source, undo],
  );

  const composer = useMemo(
    () => ({ open, sourceRef, committing, failure, openLink, close, confirm }),
    [close, committing, confirm, failure, open, openLink, sourceRef],
  );
  if (defect) throw defect.error;
  return composer;
}
