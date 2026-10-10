"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import {
  useFeedback,
  type FeedbackActions,
  type FeedbackContent,
  type FeedbackContextValue,
} from "@/components/feedback/Feedback";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { createRandomId } from "@/lib/createRandomId";
import { resolveResourceLocator } from "@/lib/resources/resourceLocators";
import {
  createLink,
  deleteLink,
  type LinkSource,
  type LinkTarget,
} from "./links";

const CREATE_FAILURES: Record<string, string> = {
  E_NOT_FOUND:
    "The source or target is no longer available. Choose another target.",
  E_INVALID_REQUEST:
    "This selection or target can’t be linked. Choose another target.",
  E_LINK_SELF: "An item can’t be linked to itself. Choose another target.",
  E_LINK_CAPABILITY:
    "This source or target doesn’t support links. Choose another target.",
  E_LINK_TARGET_AMBIGUOUS:
    "That passage matches more than once. Choose a more specific target.",
  E_LINK_TARGET_STALE: "That passage changed. Search for it again, then retry.",
  E_HIGHLIGHT_CONFLICT:
    "The selected passage changed. Close Link, select the passage again, and retry.",
  E_IDEMPOTENCY_KEY_REPLAY_MISMATCH:
    "The link request changed. Close Link, then try again.",
};
const UNCONFIRMED = "Couldn’t confirm the change.";

/** A request that may still have been applied: its retry must replay it. */
function outcomeUnknown(error: unknown): boolean {
  return (
    isApiError(error) &&
    !isSameSystemApiDefect(error) &&
    (error.code === "E_NETWORK" || error.code === "E_UPSTREAM_TIMEOUT")
  );
}

/** The finite create-failure table; an unknown code or a defect stays a defect. */
function createFailure(error: unknown): FeedbackContent {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
  const { code, requestId } = error;
  if (outcomeUnknown(error)) {
    return {
      tone: "Warning",
      title: UNCONFIRMED,
      message: "The link may already be saved. Retry checks the same change.",
      requestId,
    };
  }
  const message = Object.hasOwn(CREATE_FAILURES, code)
    ? CREATE_FAILURES[code]
    : undefined;
  if (message === undefined) throw error;
  return { tone: "Danger", title: "Link wasn’t created", message, requestId };
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

export interface LinkComposerFailure {
  content: FeedbackContent;
  actions: FeedbackActions;
}

export interface LinkComposer {
  open: boolean;
  sourceRef: string | undefined;
  sourceLabel: string;
  committing: boolean;
  failure: LinkComposerFailure | null;
  openLink: (input: LinkSessionInput) => void;
  openResourceLink: (ref: string) => Promise<void>;
  linkTo: (
    input: LinkSessionInput & { target: LinkTarget; targetLabel: string },
  ) => Promise<void>;
  close: () => void;
  confirm: (target: LinkTarget, label: string) => Promise<void>;
}

/** The open picker's failure, and whether its outcome is unknown. */
type Pending = { key: string; unknown: boolean; failure: LinkComposerFailure };

interface Snapshot {
  session: LinkSessionInput | null;
  open: boolean;
  committing: boolean;
  pending: Pending | null;
  defect: { error: unknown } | null;
}

/**
 * The app's one link-mutation owner. A pick freezes its intent (a fresh mutation id)
 * and keeps running when the picker closes; a failure stays in the open picker with an
 * exact Retry, or becomes a persistent notice once the picker is closed. One save runs
 * at a time.
 */
function createLinkComposer(feedback: FeedbackContextValue) {
  let snap: Snapshot = {
    session: null,
    open: false,
    committing: false,
    pending: null,
    defect: null,
  };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<Snapshot>) => {
    snap = { ...snap, ...patch };
    for (const listener of listeners) listener();
  };
  const persist = (key: string, failure: LinkComposerFailure) =>
    feedback.publish({
      kind: "Persistent",
      key,
      announcement: "Polite",
      ...failure,
    });

  async function undo(linkId: string, owner: LinkSessionInput): Promise<void> {
    const key = `resource-link-undo:${linkId}`;
    try {
      await deleteLink(linkId);
      feedback.resolve(key);
      owner.onLinked?.();
    } catch (error) {
      if (handleUnauthenticatedApiError(error)) return;
      // Removal is idempotent and only user links are undone: only an unknown
      // outcome is expected; anything else is a defect.
      if (!outcomeUnknown(error)) return set({ defect: { error } });
      persist(key, {
        content: {
          tone: "Warning",
          title: UNCONFIRMED,
          message: "Retry removes the same link; its items remain saved.",
        },
        actions: [{ label: "Retry", onClick: () => void undo(linkId, owner) }],
      });
    }
  }

  /** `picked`: the intent came from the open session's picker, not a direct `linkTo`. */
  async function run(
    owner: LinkSessionInput,
    target: LinkTarget,
    label: string,
    picked: boolean,
  ): Promise<void> {
    const intent = {
      clientMutationId: createRandomId("link"),
      source: owner.source,
      target,
    };
    const key = `resource-link:${intent.clientMutationId}`;
    const current = () => picked && snap.session === owner;
    async function submit(): Promise<void> {
      if (snap.committing) {
        return persist(key, {
          content: {
            tone: "Info",
            title: owner.savedFile
              ? "File saved. Link pending."
              : "Link pending",
            message:
              "Another link is being saved. Retry this link when it finishes.",
          },
          actions: [{ label: "Retry link", onClick: () => void submit() }],
        });
      }
      set({ committing: true, ...(current() ? { pending: null } : {}) });
      try {
        const { created, connection } = await createLink(intent);
        feedback.resolve(key);
        const closing = current() && snap.open;
        if (current()) set({ open: false, pending: null });
        const linkId = connection.edge_id;
        const { onAddLinkNote: addNote, onViewConnection: view } = owner;
        const undoAction = {
          label: "Undo",
          onClick: () => void undo(linkId, owner),
        };
        const note = {
          label: "Add note to link",
          onClick: () => addNote?.(linkId),
        };
        const actions: FeedbackActions | undefined = !created
          ? view && [{ label: "View connection", onClick: view }]
          : addNote
            ? [undoAction, note]
            : [undoAction];
        feedback.publish({
          kind: "Hud",
          content: {
            tone: created ? "Success" : "Info",
            title: created ? "Linked" : "Already linked",
            message: owner.savedFile
              ? `${label}. Undo removes the link; the file stays saved.`
              : label,
          },
          actions,
        });
        if (current() || !picked) owner.onLinked?.();
        if (closing) owner.onClose?.();
      } catch (error) {
        if (handleUnauthenticatedApiError(error)) return;
        try {
          const content = createFailure(error);
          const failure: LinkComposerFailure = {
            content: owner.savedFile
              ? {
                  ...content,
                  title: "File saved. Link not confirmed.",
                  message:
                    "Retry link uses the saved file. It won’t upload it again.",
                }
              : content,
            actions: [
              {
                label: owner.savedFile ? "Retry link" : "Retry",
                onClick: () => void submit(),
              },
            ],
          };
          if (current() && snap.open) {
            set({ pending: { key, unknown: outcomeUnknown(error), failure } });
          } else {
            persist(key, failure);
          }
        } catch (defect) {
          set({ defect: { error: defect } });
        }
      } finally {
        set({ committing: false });
      }
    }
    await submit();
  }

  function openLink(input: LinkSessionInput): void {
    if (snap.open) return;
    if (snap.committing) {
      feedback.publish({
        kind: "Hud",
        content: {
          tone: "Info",
          title: "Another link is being saved.",
          message: "Link again when it finishes.",
        },
      });
      return;
    }
    set({ session: input, open: true, pending: null });
  }

  function close(): void {
    const { session, open, pending } = snap;
    if (!open || !session) return;
    set({ open: false });
    session.onClose?.();
    if (pending) persist(pending.key, pending.failure);
  }

  async function confirm(target: LinkTarget, label: string): Promise<void> {
    const { session, open, committing, pending } = snap;
    if (!open || !session || committing) return;
    // A re-pick drops a definite failure; an unknown outcome stays retryable.
    if (pending?.unknown) persist(pending.key, pending.failure);
    await run(session, target, label, true);
  }

  async function openResourceLink(ref: string): Promise<void> {
    try {
      const { resourceItem: item } = await resolveResourceLocator({
        kind: "resource_ref",
        ref,
      });
      if (item.missing || item.capabilities.linkMode === "none") {
        feedback.publish({
          kind: "Hud",
          content: { tone: "Warning", title: "This item can’t be linked." },
        });
        return;
      }
      openLink({
        source:
          item.capabilities.linkMode === "materialize_passage"
            ? { kind: "passage", candidate_ref: item.ref }
            : { kind: "resource", ref: item.ref },
        sourceRef: item.ref,
        label: item.label,
      });
    } catch (error) {
      if (handleUnauthenticatedApiError(error)) return;
      try {
        feedback.publish({ kind: "Hud", content: createFailure(error) });
      } catch (defect) {
        set({ defect: { error: defect } });
      }
    }
  }

  const commands = {
    openLink,
    openResourceLink,
    close,
    confirm,
    linkTo: (
      input: LinkSessionInput & { target: LinkTarget; targetLabel: string },
    ) => run(input, input.target, input.targetLabel, false),
  };
  return {
    commands,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    snapshot: () => snap,
  };
}

/** Binds the one composer to React; renders rethrow a defect. */
export function useLinkComposer(): LinkComposer {
  const feedback = useFeedback();
  const [composer] = useState(() => createLinkComposer(feedback));
  const snap = useSyncExternalStore(
    composer.subscribe,
    composer.snapshot,
    composer.snapshot,
  );
  const bound = useMemo(
    () => ({
      ...composer.commands,
      open: snap.open,
      sourceRef: snap.session?.sourceRef,
      sourceLabel: snap.session?.label ?? "item",
      committing: snap.committing,
      failure: snap.pending?.failure ?? null,
    }),
    [composer, snap],
  );
  if (snap.defect) throw snap.defect.error;
  return bound;
}
