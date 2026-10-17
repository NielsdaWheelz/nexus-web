"use client";

import {
  createElement,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  useFeedback,
  useWorkspaceCondition,
  type FeedbackActions,
  type FeedbackAction,
  type FeedbackContent,
  type FeedbackContextValue,
  type FeedbackOffer,
} from "@/components/feedback/Feedback";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { createRandomId } from "@/lib/createRandomId";
import { RESOURCE_CAPABILITIES } from "@/lib/resources/resourceCapabilities";
import { resolveResourceItem } from "@/lib/resources/items";
import { parseResourceRef } from "./resourceRef";
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
  actions?: readonly [FeedbackAction];
}

export interface LinkComposer {
  feedback: ReactNode;
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
  recoveries: readonly (LinkComposerFailure & { key: string })[];
}

/**
 * The app's one link-mutation owner. A pick freezes its intent (a fresh link id)
 * and keeps running when the picker closes; a failure stays in the open picker with an
 * exact Retry, or becomes a persistent notice once the picker is closed. One save runs
 * at a time.
 */
function createLinkComposer(feedback: FeedbackContextValue) {
  let live = true;
  let busyNotice: FeedbackOffer | null = null;
  let snap: Snapshot = {
    session: null,
    open: false,
    committing: false,
    pending: null,
    defect: null,
    recoveries: [],
  };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<Snapshot>) => {
    if (!live) return;
    snap = { ...snap, ...patch };
    for (const listener of listeners) listener();
  };
  const persist = (key: string, failure: LinkComposerFailure, unknown: boolean) => {
    if (!unknown) return feedback.offer({ key, announcement: "Polite", ...failure });
    set({
      recoveries: [
        ...snap.recoveries.filter((item) => item.key !== key),
        { key, ...failure },
      ],
    });
    return null;
  };
  const resolve = (key: string) =>
    set({ recoveries: snap.recoveries.filter((item) => item.key !== key) });
  const busy = (key: string, value: boolean) =>
    set({
      recoveries: snap.recoveries.map((item) => {
        const action = item.actions?.[0];
        return item.key === key && action?.onClick
          ? { ...item, actions: [{ ...action, busy: value }] as const }
          : item;
      }),
    });

  async function undo(
    linkId: string,
    owner: LinkSessionInput,
    offer: FeedbackOffer,
  ): Promise<void> {
    if (!live) return;
    const key = `resource-link-undo:${linkId}`;
    busy(key, true);
    offer.update({
      content: { tone: "Success", title: "linked" },
      announcement: "None",
      actions: [
        {
          label: "undo",
          onClick: () => void undo(linkId, owner, offer),
          busy: true,
        },
      ],
    });
    try {
      await deleteLink(linkId);
      if (!live) return;
      resolve(key);
      offer.withdraw();
      owner.onLinked?.();
    } catch (error) {
      if (!live) return;
      if (handleUnauthenticatedApiError(error)) return;
      // Removal is idempotent and only user links are undone: only an unknown
      // outcome is expected; anything else is a defect.
      if (!outcomeUnknown(error)) return set({ defect: { error } });
      persist(
        key,
        {
          content: {
            tone: "Warning",
            title: UNCONFIRMED,
            message: "Retry removes the same link; its items remain saved.",
          },
          actions: [{ label: "undo", onClick: () => void undo(linkId, owner, offer) }],
        },
        true,
      );
    }
  }

  /** `picked`: the intent came from the open session's picker, not a direct `linkTo`. */
  async function run(
    owner: LinkSessionInput,
    target: LinkTarget,
    label: string,
    picked: boolean,
  ): Promise<void> {
    if (!live) return;
    const intent = { link_id: createRandomId(), source: owner.source, target };
    const key = `resource-link:${intent.link_id}`;
    const current = () => picked && snap.session === owner;
    let advisory: FeedbackOffer | null = null;
    let settled = false;
    async function submit(): Promise<void> {
      if (!live || settled) return;
      if (snap.committing) {
        advisory?.withdraw();
        advisory = persist(
          key,
          {
            content: {
              tone: "Info",
              title: owner.savedFile
                ? "File saved. Link pending."
                : "Link pending",
              message:
                "Another link is being saved. Retry this link when it finishes.",
            },
            actions: [{ label: "Retry link", onClick: () => void submit() }],
          },
          false,
        );
        return;
      }
      advisory?.update({
        content: {
          tone: "Neutral",
          title: owner.savedFile ? "file saved. linking…" : "linking…",
        },
        announcement: "Polite",
        actions: [{ label: "Retry link", onClick: () => void submit(), busy: true }],
      });
      const pending = current() && snap.pending?.key === key ? snap.pending : null;
      const retry = pending?.failure.actions?.[0];
      set({
        committing: true,
        ...(current()
          ? {
              pending: pending === null ? null : {
                ...pending,
                failure: {
                  ...pending.failure,
                  actions: retry?.onClick
                    ? [{ ...retry, busy: true }] as const
                    : pending.failure.actions,
                },
              },
            }
          : {}),
      });
      busy(key, true);
      try {
        const { created, connection } = await createLink(intent);
        if (!live) return;
        settled = true;
        advisory?.withdraw();
        resolve(key);
        const closing = current() && snap.open;
        if (current()) set({ open: false, pending: null });
        const linkId = connection.edge_id;
        const { onAddLinkNote: addNote, onViewConnection: view } = owner;
        if (!created && !view) {
          feedback.receipt({ tone: "Info", title: "Already linked" });
        } else {
          const undoAction = {
            label: "undo",
            onClick: () => void undo(linkId, owner, resultOffer),
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
          const resultOffer = feedback.offer({
            key: `resource-link-undo:${linkId}`,
            announcement: "Polite",
            content: {
              tone: created ? "Success" : "Info",
              title: created ? "Linked" : "Already linked",
              message: owner.savedFile && created
                ? `${label}. Undo removes the link; the file stays saved.`
                : label,
            },
            actions,
          });
        }
        if (current() || !picked) owner.onLinked?.();
        if (closing) owner.onClose?.();
      } catch (error) {
        if (!live) return;
        if (handleUnauthenticatedApiError(error)) return;
        try {
          const content = createFailure(error);
          const unknown = outcomeUnknown(error);
          settled = !unknown;
          const failure: LinkComposerFailure = {
            content: owner.savedFile && outcomeUnknown(error)
              ? {
                  ...content,
                  title: "File saved. Link not confirmed.",
                  message:
                    "Retry link uses the saved file. It won’t upload it again.",
                }
              : owner.savedFile
                ? { ...content, title: "File saved. Link wasn’t created." }
                : content,
            actions: outcomeUnknown(error)
              ? [{
                  label: owner.savedFile ? "Retry link" : "Retry",
                  onClick: () => void submit(),
                }]
              : undefined,
          };
          if (current() && snap.open) {
            advisory?.withdraw();
            set({ pending: { key, unknown, failure } });
          } else {
            advisory = persist(key, failure, unknown);
          }
        } catch (defect) {
          set({ defect: { error: defect } });
        }
      } finally {
        set({ committing: false });
        busyNotice?.withdraw();
        busyNotice = null;
      }
    }
    await submit();
  }

  function openLink(input: LinkSessionInput): void {
    if (!live) return;
    if (snap.open) return;
    if (snap.committing) {
      busyNotice?.withdraw();
      busyNotice = feedback.offer({
        key: "link-composer-busy",
        announcement: "Polite",
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
    if (!live) return;
    const { session, open, pending } = snap;
    if (!open || !session) return;
    set({ open: false });
    session.onClose?.();
    if (pending) persist(pending.key, pending.failure, pending.unknown);
  }

  async function confirm(target: LinkTarget, label: string): Promise<void> {
    const { session, open, committing, pending } = snap;
    if (!open || !session || committing) return;
    // A re-pick drops a definite failure; an unknown outcome stays retryable.
    if (pending?.unknown) persist(pending.key, pending.failure, true);
    await run(session, target, label, true);
  }

  async function openResourceLink(ref: string): Promise<void> {
    if (!live) return;
    try {
      const item = await resolveResourceItem(ref);
      if (!live) return;
      const linkMode = RESOURCE_CAPABILITIES[parseResourceRef(item.ref)!.scheme].link_mode;
      if (item.missing || linkMode === "none") {
        feedback.offer({
          key: `resource-link:${ref}`,
          announcement: "Polite",
          content: { tone: "Warning", title: "This item can’t be linked." },
        });
        return;
      }
      openLink({
        source:
          linkMode === "materialize_passage"
            ? { kind: "passage", candidate_ref: item.ref }
            : { kind: "resource", ref: item.ref },
        sourceRef: item.ref,
        label: item.label,
      });
    } catch (error) {
      if (!live) return;
      if (handleUnauthenticatedApiError(error)) return;
      try {
        feedback.offer({
          key: `resource-link:${ref}`,
          announcement: "Polite",
          content: createFailure(error),
        });
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
    attach() {
      live = true;
      return () => {
        live = false;
      };
    },
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
  useLayoutEffect(() => composer.attach(), [composer]);
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
      feedback: snap.recoveries.map((recovery) =>
        createElement(LinkRecovery, { key: recovery.key, recovery }),
      ),
    }),
    [composer, snap],
  );
  if (snap.defect) throw snap.defect.error;
  return bound;
}

function LinkRecovery({
  recovery,
}: {
  recovery: LinkComposerFailure & { key: string };
}) {
  useWorkspaceCondition(recovery.key, {
    priority: "Write",
    announcement: "Polite",
    content: recovery.content,
    actions: recovery.actions,
  });
  return null;
}
