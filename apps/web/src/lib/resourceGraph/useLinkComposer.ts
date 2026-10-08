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
import type { CreateLinkInput, LinkSource, LinkTarget } from "@/lib/resourceGraph/links";

import { resolveResourceLocator } from "@/lib/resources/resourceLocators";

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
          title: "Couldn’t confirm the change.",
          message:
            "The link may already be saved. Retry checks the same change.",
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
          title: "Couldn’t confirm the change.",
          message:
            "The link may already be saved. Retry checks the same change.",
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

export interface LinkSessionInput {
  source: LinkSource;
  sourceRef?: string;
  label: string;
  onLinked?: () => void;
  onClose?: () => void;
  onAddLinkNote?: (linkId: string) => void;
  onViewConnection?: () => void;
  savedFile?: boolean;
}

type Session = LinkSessionInput & { key: number };
export interface LinkComposer {
  open: boolean;
  sourceRef: string | undefined;
  sourceLabel: string;
  committing: boolean;
  failure: LinkComposerFailure | null;
  openLink: (input: LinkSessionInput) => void;
  openResourceLink: (ref: string) => Promise<void>;
  linkTo: (input: LinkSessionInput & { target: LinkTarget; targetLabel: string }) => Promise<void>;
  close: () => void;
  confirm: (target: LinkTarget, label: string) => Promise<void>;
}

/** One app-owned mutation session. Closing a submitted picker never abandons its intent. */
export function useLinkComposer(): LinkComposer {
  const feedback = useFeedback();
  const [session, setSession] = useState<Session | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const nextKey = useRef(0);
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  const [committing, setCommitting] = useState(false);
  const [failure, setFailure] = useState<LinkComposerFailure | null>(null);
  const failureRef = useRef<{ key: string; failure: LinkComposerFailure } | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const commitGuard = useRef(false);

  const openLink = useCallback((input: LinkSessionInput) => {
    if (commitGuard.current || openRef.current) return;
    const next = { ...input, key: ++nextKey.current };
    sessionRef.current = next;
    setSession(next);
    setFailure(null);
    failureRef.current = null;
    openRef.current = true;
    setOpen(true);
  }, []);

  const close = useCallback(() => {
    openRef.current = false;
    setOpen(false);
    sessionRef.current?.onClose?.();
    const pending = failureRef.current;
    if (pending) feedback.publish({
      kind: "Persistent", key: pending.key, announcement: "Polite", ...pending.failure,
    });
  }, [feedback]);

  const undo = useCallback(async (linkId: string, owner: LinkSessionInput) => {
    const key = `resource-link-undo:${linkId}`;
    try {
      await deleteLink(linkId);
      feedback.resolve(key);
      owner.onLinked?.();
    } catch (error) {
      if (handleUnauthenticatedApiError(error)) return;
      try {
        feedback.publish({
          kind: "Persistent", key, announcement: "Polite",
          content: isUndoOutcomeUnknown(error) ? {
            tone: "Warning", title: "Couldn’t confirm the change.",
            message: "Retry removes the same link; its items remain saved.",
          } : linkErrorMessage(error, "Undo"),
          actions: [{ label: "Retry", onClick: () => void undo(linkId, owner) }],
        });
      } catch (error) { setDefect({ error }); }
    }
  }, [feedback]);

  const run = useCallback(async (owner: LinkSessionInput, intent: CreateLinkInput, label: string, sessionKey: number | null) => {
    const key = `resource-link:${intent.clientMutationId}`;
    const current = () => sessionKey !== null && sessionRef.current?.key === sessionKey;
    async function submit() {
      if (commitGuard.current) {
        feedback.publish({ kind: "Persistent", key, announcement: "Polite",
          content: { tone: "Info", title: owner.savedFile ? "File saved. Link pending." : "Link pending", message: "Another link is being saved. Retry this link when it finishes." },
          actions: [{ label: "Retry link", onClick: () => void submit() }],
        });
        return;
      }
      commitGuard.current = true;
      setCommitting(true);
      if (current()) { setFailure(null); failureRef.current = null; }
      try {
        const result = await createLink(intent);
        feedback.resolve(key);
        const notifyClose = current() && openRef.current;
        if (current()) {
          openRef.current = false;
          setOpen(false);
          setFailure(null);
          failureRef.current = null;
        }
        const linkId = result.connection.edge_id;
        let actions: FeedbackActions | undefined;
        if (result.created) {
          const undoAction = { label: "Undo", onClick: () => void undo(linkId, owner) };
          actions = owner.onAddLinkNote
            ? [undoAction, { label: "Add note to link", onClick: () => owner.onAddLinkNote?.(linkId) }]
            : [undoAction];
        } else if (owner.onViewConnection) {
          actions = [{ label: "View connection", onClick: owner.onViewConnection }];
        }
        feedback.publish({
          kind: "Hud",
          content: { tone: result.created ? "Success" : "Info", title: result.created ? "Linked" : "Already linked", message: owner.savedFile ? `${label}. Undo removes the link; the file stays saved.` : label },
          actions,
        });
        if (current() || sessionKey === null) owner.onLinked?.();
        if (notifyClose) owner.onClose?.();
      } catch (error) {
        if (handleUnauthenticatedApiError(error)) return;
        try {
          const failed: LinkComposerFailure = {
            content: owner.savedFile ? { ...linkErrorMessage(error, "Create"), title: "File saved. Link not confirmed.", message: "Retry link uses the saved file. It won’t upload it again." } : linkErrorMessage(error, "Create"),
            actions: [{ label: owner.savedFile ? "Retry link" : "Retry", onClick: () => void submit() }],
          };
          if (current()) { setFailure(failed); failureRef.current = { key, failure: failed }; }
          if (!current() || !openRef.current) feedback.publish({
            kind: "Persistent", key, announcement: "Polite", ...failed,
          });
        } catch (error) { setDefect({ error }); }
      } finally {
        commitGuard.current = false;
        setCommitting(false);
      }
    }
    await submit();
  }, [feedback, undo]);

  const confirm = useCallback(async (target: LinkTarget, label: string) => {
    const owner = sessionRef.current;
    if (!owner || commitGuard.current) return;
    const pending = failureRef.current;
    if (pending) feedback.publish({ kind: "Persistent", key: pending.key, announcement: "Polite", ...pending.failure });
    await run(owner, { clientMutationId: createRandomId("link"), source: owner.source, target }, label, owner.key);
  }, [feedback, run]);

  const linkTo = useCallback(async (input: LinkSessionInput & { target: LinkTarget; targetLabel: string }) => {
    await run(input, { clientMutationId: createRandomId("link"), source: input.source, target: input.target }, input.targetLabel, null);
  }, [run]);

  const openResourceLink = useCallback(async (ref: string) => {
    try {
      const { resourceItem } = await resolveResourceLocator({ kind: "resource_ref", ref });
      if (resourceItem.missing || resourceItem.capabilities.linkMode === "none") {
        feedback.publish({ kind: "Hud", content: { tone: "Warning", title: "This item can’t be linked." } });
        return;
      }
      openLink({
        source: resourceItem.capabilities.linkMode === "materialize_passage"
          ? { kind: "passage", candidate_ref: resourceItem.ref }
          : { kind: "resource", ref: resourceItem.ref },
        sourceRef: resourceItem.ref, label: resourceItem.label,
      });
    } catch (error) {
      if (handleUnauthenticatedApiError(error)) return;
      try { feedback.publish({ kind: "Hud", content: linkErrorMessage(error, "Create") }); }
      catch (error) { setDefect({ error }); }
    }
  }, [feedback, openLink]);

  const composer = useMemo(() => ({
    open, sourceRef: session?.sourceRef, sourceLabel: session?.label ?? "item", committing, failure,
    openLink, openResourceLink, linkTo, close, confirm,
  }), [open, session, committing, failure, openLink, openResourceLink, linkTo, close, confirm]);
  if (defect) throw defect.error;
  return composer;
}
