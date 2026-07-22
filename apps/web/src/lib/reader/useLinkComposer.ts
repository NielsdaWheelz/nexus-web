"use client";

import { useCallback, useState } from "react";
import { toFeedback, useFeedback } from "@/components/feedback/Feedback";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { createLink, deleteLink } from "@/lib/resourceGraph/links";
import type { LinkSource, LinkTarget } from "@/lib/resourceGraph/links";

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

  const openLink = useCallback(
    (args: { source: LinkSource; sourceRef?: string }) => {
      setSource(args.source);
      setSourceRef(args.sourceRef);
      setOpen(true);
    },
    [],
  );

  const close = useCallback(() => {
    setOpen(false);
    setSource(null);
    setSourceRef(undefined);
  }, []);

  const undo = useCallback(
    async (linkId: string) => {
      try {
        await deleteLink(linkId);
        onLinked();
      } catch (error) {
        if (handleUnauthenticatedApiError(error)) return;
        feedback.show(toFeedback(error, { fallback: "Failed to undo link" }));
      }
    },
    [feedback, onLinked],
  );

  const confirm = useCallback(
    async (target: LinkTarget, label: string) => {
      if (!source || committing) return;
      setCommitting(true);
      try {
        const result = await createLink({ source, target });
        onLinked();
        setOpen(false);
        setSource(null);
        setSourceRef(undefined);

        if (result.created) {
          const linkId = result.connection.edge_id;
          feedback.show({
            severity: "success",
            title: `Linked to ${label}`,
            action: [
              { label: "Undo", onClick: () => void undo(linkId) },
              ...(onAddLinkNote
                ? [{ label: "Add note to link", onClick: () => onAddLinkNote(linkId) }]
                : []),
            ],
          });
        } else {
          feedback.show({
            severity: "info",
            title: `Already linked to ${label}`,
            action: onViewConnection
              ? { label: "View connection", onClick: onViewConnection }
              : undefined,
          });
        }
      } catch (error) {
        if (handleUnauthenticatedApiError(error)) return;
        // Keep the dialog and selection open; surface the failure with a Retry.
        feedback.show({
          ...toFeedback(error, { fallback: "Failed to create link" }),
          action: { label: "Retry", onClick: () => void confirm(target, label) },
        });
      } finally {
        setCommitting(false);
      }
    },
    [committing, feedback, onAddLinkNote, onLinked, onViewConnection, source, undo],
  );

  return { open, sourceRef, committing, openLink, close, confirm };
}
