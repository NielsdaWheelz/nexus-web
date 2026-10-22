"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Copy, Send, Share2 } from "lucide-react";
import { FeedbackNotice, FeedbackStatus, type FeedbackContent } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import ButtonLink from "@/components/ui/ButtonLink";
import Dialog from "@/components/ui/Dialog";
import MobileSheet from "@/components/ui/MobileSheet";
import PeopleSearch, { personLabel } from "@/components/users/PeopleSearch";
import {
  apiFetch,
  apiTransportFeedback,
  isApiError,
  isSameSystemApiDefect,
  type ApiPath,
} from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import type { TargetActivationEvent } from "@/lib/ui/targetActivation";
import type { ShareSession } from "@/lib/sharing/controller";
import type { CanonicalResourceRef, ShareMode } from "@/lib/sharing/types";
import { ClipboardWriteUnavailableError, copyText } from "@/lib/ui/copyText";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { useWorkspaceStore } from "@/lib/workspace/store";
import styles from "./ShareOverlay.module.css";

type Snapshot = Schema<"ResourceShareSnapshotOut">;
type SharesJson<M extends "get" | "post"> = ApiJson<"/resource-items/{resource_ref}/shares", M>;

const MODE_INTRO: Record<ShareMode, string> = {
  None: "Sharing is not available for this item.",
  CopyOnly: "This link does not change who can open the item.",
  ResourceGrants:
    "Copying the Nexus link does not grant access. Add a person or turn on your public link explicitly.",
  HighlightGrants:
    "Sharing this highlight includes its source media, but none of your other highlights or notes.",
  LibraryMembership:
    "Only library members can open this link. Membership is managed separately from library settings.",
};

const UNAVAILABLE: Record<Schema<"AudienceUnavailableOut">["reason"], string> = {
  UnsupportedSubject: "Access sharing is not available for this item.",
  Deleting: "This item is being removed, so access cannot be shared.",
  InsufficientAuthority: "You can copy the link, but you cannot grant access.",
  HighlightUnresolved:
    "This highlight cannot be opened at its exact location, so it cannot be shared.",
  ProjectionNotReady: "The public reader is still being prepared.",
  ProjectionUnsupported: "A public link is not available for this format.",
};

function sharesPath(ref: CanonicalResourceRef): ApiPath {
  return `/api/resource-items/${encodeURIComponent(ref)}/shares`;
}

/** The notice for a failed load or change, or null after a 401 went to the auth boundary. */
function feedbackFor(error: unknown, title: string, mutation: boolean): FeedbackContent | null {
  if (handleUnauthenticatedApiError(error)) return null;
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
  if (mutation && error.code === "E_NETWORK") {
    return {
      tone: "Danger",
      title: "It’s unclear whether the sharing change completed.",
      message: "Refresh sharing options before trying again.",
      requestId: error.requestId,
    };
  }
  const transport = apiTransportFeedback(error, title);
  if (transport) return transport;
  const known = new Map([
    ["E_USER_NOT_FOUND", "This person is no longer available to share with."],
    ["E_FORBIDDEN", mutation ? title : "You don’t have access to these sharing options."],
    ["E_NOT_FOUND", title],
    ["E_INVALID_REQUEST", title],
  ]).get(error.code);
  if (known === undefined) throw error;
  return { tone: "Danger", title: known, requestId: error.requestId };
}

export default function ShareOverlay(props: { session: ShareSession | null; onClose: () => void }) {
  const { session, onClose } = props;
  const isMobile = useIsMobileViewport();
  const navigated = useRef(false);
  useEffect(() => { navigated.current = false; }, [session]);
  const fallback = session?.options.returnFocusFallback;
  const focus = {
    skipReturnFocus: () => navigated.current,
    returnFocusTo: session?.options.returnFocusTo,
    returnFocusFallback: fallback ?? undefined,
  };
  const panel = session && <SharePanel key={session.key} session={session} onClose={() => { navigated.current = true; onClose(); }} />;
  return (
    <>
      <Dialog open={session !== null && !isMobile} onClose={onClose} title="Share" {...focus}>
        {panel}
      </Dialog>
      <MobileSheet
        active={session !== null && isMobile}
        onDismiss={onClose}
        ariaLabel="share"
        panelId="share-sheet"
        {...focus}
      >
        {panel}
      </MobileSheet>
    </>
  );
}

/** What the grant editor borrows from the panel: the live region, errors, copy and share. */
interface PanelActions {
  announce: (message: string) => void;
  fail: (error: unknown, title: string) => void;
  copy: (href: string, label: string) => Promise<void>;
  nativeShare: (url: string, title: string) => Promise<boolean>;
}

function SharePanel({ session, onClose }: { session: ShareSession; onClose: () => void }) {
  const { target } = session;
  // A failed read keeps its recovery control until the replacement read settles.
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loadError, setLoadError] = useState<FeedbackContent | null>(null);
  const [liveMessage, setLiveMessage] = useState("");
  const [actionError, setActionError] = useState<{ content: FeedbackContent; check: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const reading = useRef<AbortSignal | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  // A defect found in a callback is rethrown while rendering, so the error boundary sees it.
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const workspace = useWorkspaceStore();

  const explain = useCallback((error: unknown, title: string, mutation: boolean) => {
    if (lifetime.current?.signal.aborted) return null;
    try {
      return feedbackFor(error, title, mutation);
    } catch (thrown) {
      setDefect({ error: thrown });
      return null;
    }
  }, []);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      const currentSignal = signal ?? lifetime.current?.signal;
      if (target.kind === "Route" || !currentSignal || currentSignal.aborted || (reading.current !== null && !reading.current.aborted)) return;
      reading.current = currentSignal;
      setLoading(true);
      try {
        const next = (await apiFetch<SharesJson<"get">>(sharesPath(target.ref), { signal: currentSignal })).data;
        if (currentSignal.aborted) return;
        setSnapshot(next);
        setLoadError(null);
        setActionError((current) => current?.check ? null : current);
      } catch (error) {
        if (currentSignal.aborted) return;
        setLoadError(explain(error, "Sharing options couldn’t be loaded.", false));
      } finally {
        if (reading.current === currentSignal) reading.current = null;
        if (!currentSignal.aborted) setLoading(false);
      }
    },
    [explain, target],
  );

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (defect !== null) throw defect.error;

  const showError = (content: FeedbackContent | null, check = false) => {
    if (!content) return;
    setLiveMessage("");
    setActionError({ content, check });
  };
  const actions: PanelActions = {
    announce: (message) => {
      setActionError(null);
      setLiveMessage("");
      requestAnimationFrame(() => setLiveMessage(message));
    },
    fail: (error, title) => showError(explain(error, title, true), isApiError(error) && error.code === "E_NETWORK"),
    copy: async (href, label) => {
      try {
        await copyText(href);
        actions.announce(`${label} copied.`);
      } catch (error) {
        if (!(error instanceof ClipboardWriteUnavailableError)) setDefect({ error });
        else showError({ tone: "Danger", title: "The link could not be copied. Try again." });
      }
    },
    nativeShare: async (url, title) => {
      try {
        await navigator.share({ title, url });
        return true;
      } catch (error) {
        const expected = ["AbortError", "DataError", "InvalidStateError", "NotAllowedError"];
        if (!(error instanceof DOMException && expected.includes(error.name))) setDefect({ error });
        else if (error.name !== "AbortError") {
          showError({ tone: "Danger", title: "The share menu could not be opened." });
        }
        return false;
      }
    },
  };

  const mode: ShareMode = target.kind === "Route" ? "CopyOnly" : (snapshot?.sharing ?? "None");
  const href =
    target.kind === "Route"
      ? new URL(target.href, process.env.NEXT_PUBLIC_APP_PUBLIC_ORIGIN).toString()
      : (snapshot?.authenticated_href ?? null);
  const label = target.kind === "Route" ? target.label : `${target.ref.split(":")[0]} link`;
  const members = snapshot?.members != null ? snapshot.members : null;

  const manageMembers = (event: TargetActivationEvent) => {
    if (!snapshot) return;
    const result = activateTargetLink({ event,
      runtime: { activateTarget: input => workspace.activateWorkspaceTarget({ ...input, originPaneId: workspace.state.active_primary_pane_id }) },
      target: { href: snapshot.authenticated_href, secondaryActivation: { surfaceId: "resource-members" } },
    });
    if (result === "handled-default" || result === "handled-new-pane") onClose();
  };

  return (
    <div className={styles.panel} ref={panel} tabIndex={-1}>
      {target.kind === "Resource" && !snapshot && !loadError
        ? <FeedbackStatus content={{ tone: "Neutral", title: "loading sharing options…" }} announcement="Polite" />
        : <p className={styles.note}>{MODE_INTRO[mode]}</p>}
      <Section
        id="share-nexus-link"
        title="Nexus link"
        note={mode === "LibraryMembership" ? "Only members can open this link." : label}
        aside={
          <span className={styles.actions}>
            <Button
              icon={<Copy />}
              disabled={!href}
              onClick={() => href && void actions.copy(href, "Nexus link")}
            >
              Copy link
            </Button>
            {typeof navigator.share === "function" ? (
              <Button
                icon={<Share2 />}
                disabled={!href}
                onClick={() => href && void actions.nativeShare(href, label)}
              >
                Share
              </Button>
            ) : null}
          </span>
        }
      />
      {loadError ? (
        <FeedbackNotice
          content={loadError}
          announcement="Assertive"
          actions={actionError?.check ? undefined : [{ label: "retry", onClick: () => void load(), busy: loading }]}
          returnFocus={() => panel.current}
        />
      ) : null}
      {snapshot &&
      target.kind === "Resource" &&
      (mode === "ResourceGrants" || mode === "HighlightGrants") ? (
        <GrantEditor
          subject={target.ref}
          snapshot={snapshot}
          onChange={setSnapshot}
          actions={actions}
        />
      ) : null}
      {members ? (
        <Section
          id="share-library-members"
          title="People"
          note={
            members.can_manage
              ? "Manage people, invitations, roles, and ownership in the Library pane."
              : "Members are managed by library admins."
          }
          aside={members.can_manage ? <ButtonLink href={snapshot!.authenticated_href} data-workspace-rich-target="true" onClick={manageMembers} onKeyDown={manageMembers}>Manage members</ButtonLink> : null}
        />
      ) : null}
      {actionError ? <FeedbackNotice
        content={actionError.content}
        announcement="Assertive"
        actions={actionError.check ? [{ label: "refresh sharing options", onClick: () => void load(), busy: loading }] : undefined}
        returnFocus={() => panel.current}
      /> : null}
      {liveMessage ? <FeedbackStatus content={{ tone: "Neutral", title: liveMessage }} announcement="Polite" /> : null}
    </div>
  );
}

function Section(props: {
  id: string;
  title: string;
  note: string;
  aside?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className={styles.section} aria-labelledby={props.id}>
      <div className={styles.heading}>
        <div>
          <h3 id={props.id}>{props.title}</h3>
          <p className={styles.note}>{props.note}</p>
        </div>
        {props.aside}
      </div>
      {props.children}
    </section>
  );
}

function GrantEditor(props: {
  subject: CanonicalResourceRef;
  snapshot: Snapshot;
  onChange: (snapshot: Snapshot) => void;
  actions: PanelActions;
}) {
  const { snapshot, onChange, actions } = props;
  // One change at a time: `busy` names the change in flight and disables every other one.
  const [busy, setBusy] = useState<string | null>(null);
  // One question at a time: a grant's id, or "Native" / "X" for a bearer-link warning.
  const [confirm, setConfirm] = useState<string | null>(null);
  // A retried share resends the id minted for its audience until one lands.
  const attempts = useRef(new Map<string, string>());
  const link = snapshot.shares.find((s): s is Schema<"LinkShareOut"> => s.kind === "Link");
  const people = snapshot.shares.filter((s): s is Schema<"UserShareOut"> => s.kind === "User");
  const { user: userAvailability, link: linkAvailability } = snapshot.creation_availability;
  const includesHighlight = snapshot.sharing === "HighlightGrants";

  const create = async (
    audience: Schema<"CreateResourceShareRequest">["audience"],
    key: string,
    [created, existing]: [string, string],
    errorTitle: string,
  ) => {
    setBusy(key);
    const id = attempts.current.get(key) ?? crypto.randomUUID();
    attempts.current.set(key, id);
    try {
      const { data } = await apiFetch<SharesJson<"post">>(sharesPath(props.subject), {
        method: "POST",
        body: JSON.stringify({ id, audience }),
      });
      attempts.current.delete(key);
      const known = snapshot.shares.some((share) => share.id === data.share.id);
      onChange({ ...snapshot, shares: known ? snapshot.shares : [...snapshot.shares, data.share] });
      actions.announce(data.created ? created : existing);
      return true;
    } catch (error) {
      actions.fail(error, errorTitle);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (id: string, message: string, errorTitle: string) => {
    setBusy(id);
    try {
      await apiFetch(`/api/resource-shares/${id}`, { method: "DELETE" });
      onChange({
        ...snapshot,
        shares: snapshot.shares.filter((share) => share.id !== id),
        received_access: snapshot.received_access.filter((share) => share.id !== id),
      });
      setConfirm(null);
      actions.announce(message);
    } catch (error) {
      actions.fail(error, errorTitle);
    } finally {
      setBusy(null);
    }
  };

  /** A control that asks first: `trigger` until pressed, then its question in its place. */
  const guarded = (
    key: string,
    trigger: ReactNode,
    prompt: string,
    [yes, no]: [string, string],
    onYes: () => void,
    consequence: "Destructive" | "Disclosure" = "Destructive",
  ) =>
    confirm !== key ? (
      trigger
    ) : (
      <span className={styles.confirm}>
        <span>{prompt}</span>
        <Button
          emphasis="strong"
          tone={consequence === "Destructive" ? "danger" : undefined}
          aria-busy={busy === key || undefined}
          disabled={busy !== null}
          onClick={onYes}
        >
          {yes}
        </Button>
        <Button disabled={busy !== null} onClick={() => setConfirm(null)}>
          {no}
        </Button>
      </span>
    );

  /** Remove, Decline or Turn off: a quiet danger button that asks, then deletes the grant. */
  const revocation = (
    id: string,
    copy: { label: string; prompt: string; yes: string; no: string; done: string; failed: string },
  ) =>
    guarded(
      id,
      <Button tone="danger" disabled={busy !== null} onClick={() => setConfirm(id)}>
        {copy.label}
      </Button>,
      copy.prompt,
      [copy.yes, copy.no],
      () => void revoke(id, copy.done, copy.failed),
    );

  return (
    <>
      <Section
        id="share-your-shares"
        title="Your shares"
        note="Direct shares you created. Your notes and other highlights stay private."
      >
        {userAvailability.kind === "Available" ? (
          <>
            <p className={styles.note}>
              This person can read and reshare the media. They may already have access another way.
              {includesHighlight
                ? " This share also includes this exact highlight and its source media."
                : ""}
            </p>
            <PeopleSearch
              label="Search people to share with"
              placeholder="Search people…"
              description="Search display names, or enter an account’s exact email."
              disabled={busy !== null}
              onSelect={(person) => {
                if (person === null) return;
                const name = personLabel(person);
                return create(
                  { kind: "User", user_id: person.user_id, email: person.email },
                  person.user_id,
                  [`Shared with ${name}.`, `${name} already has this share.`],
                  "Access could not be shared.",
                );
              }}
            />
          </>
        ) : (
          <p className={styles.note}>{UNAVAILABLE[userAvailability.reason]}</p>
        )}
        {people.length === 0 ? (
          <p className={styles.note}>You have not shared this directly.</p>
        ) : null}
        {people.map((share) => (
          <div key={share.id} className={styles.row}>
            <span>{personLabel(share.user)}</span>
            {revocation(share.id, {
              label: "Remove",
              prompt: "Remove only this direct share?",
              yes: "Remove direct share",
              no: "Keep",
              done: `Removed the share for ${personLabel(share.user)}.`,
              failed: "The share could not be removed.",
            })}
          </div>
        ))}
      </Section>

      {snapshot.received_access.length > 0 ? (
        <Section
          id="share-received"
          title="Shared with you"
          note="Declining removes only the access path shown here."
        >
          {snapshot.received_access.map((share) => (
            <div key={share.id} className={styles.row}>
              <span>
                {personLabel(share.shared_by)} shared this {share.subject.split(":")[0]}
              </span>
              {revocation(share.id, {
                label: "Decline",
                prompt: "Decline only this access path?",
                yes: "Decline shared access",
                no: "Keep",
                done: "This shared access path was declined.",
                failed: "The shared access could not be declined.",
              })}
            </div>
          ))}
        </Section>
      ) : null}

      <Section
        id="share-public-link"
        title="Your public link"
        note={`Anyone with this link can read the media and may share it again. Turning this off revokes only your link; it cannot revoke copies or other access paths. Your notes and other highlights stay private.${includesHighlight ? " This highlight is included." : ""}`}
        aside={<span className={styles.state}>{link ? "Unlisted · On" : "Off"}</span>}
      >
        {link ? (
          <>
            <span className={styles.actions}>
              <Button
                icon={<Copy />}
                onClick={() => void actions.copy(link.public_href, "Public link")}
              >
                Copy public link
              </Button>
              {typeof navigator.share === "function"
                ? guarded(
                    "Native",
                    <Button
                      icon={<Share2 />}
                      disabled={busy !== null}
                      onClick={() => setConfirm("Native")}
                    >
                      Share public link
                    </Button>,
                    "Sharing sends this bearer link to the app you choose. That destination gains read access and may retain the credential.",
                    ["Continue to share", "Cancel"],
                    async () => {
                      setBusy("Native");
                      const shared = actions.nativeShare(link.public_href, "Shared from Nexus");
                      if (await shared) setConfirm(null);
                      setBusy(null);
                    },
                    "Disclosure",
                  )
                : null}
              {guarded(
                "X",
                <Button
                  icon={<Send />}
                  disabled={busy !== null}
                  onClick={() => setConfirm("X")}
                >
                  Post to X
                </Button>,
                "Posting sends this bearer link to X. X gains read access and may retain the credential. Posting also makes an unlisted link effectively published.",
                ["Continue to X", "Cancel"],
                () => {
                  // With noopener, window.open returns null whether or not the tab opened.
                  const intent = `https://x.com/intent/post?url=${encodeURIComponent(link.public_href)}`;
                  window.open(intent, "_blank", "noopener,noreferrer");
                  setConfirm(null);
                },
                "Disclosure",
              )}
            </span>
            {revocation(link.id, {
              label: "Turn off public link",
              prompt:
                "Turn off only your public link? Existing copies and other access paths are unaffected.",
              yes: "Turn off public link",
              no: "Keep on",
              done: "Your public link was turned off.",
              failed: "The share could not be removed.",
            })}
          </>
        ) : linkAvailability.kind === "Available" ? (
          <Button
            aria-busy={busy === "new-link" || undefined}
            disabled={busy !== null}
            onClick={() =>
              void create(
                { kind: "Link" },
                "new-link",
                ["Your public link is on.", "Your public link was already on."],
                "Your public link could not be turned on.",
              )
            }
          >
            Turn on public link
          </Button>
        ) : (
          <p className={styles.note}>{UNAVAILABLE[linkAvailability.reason]}</p>
        )}
        <p className={styles.note}>Only share content you may redistribute.</p>
      </Section>
    </>
  );
}
