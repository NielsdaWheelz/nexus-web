"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy, Send, Share2 } from "lucide-react";
import { Fact, Failed } from "@/components/feedback/Fact";
import { Announcement, Hold, useOutcome } from "@/components/feedback/Feedback";
import { Ruling } from "@/components/feedback/Ruling";
import { useCopyFeedback } from "@/components/ui/useCopyFeedback";
import Button from "@/components/ui/Button";
import ButtonLink from "@/components/ui/ButtonLink";
import Dialog from "@/components/ui/Dialog";
import MobileSheet from "@/components/ui/MobileSheet";
import PeopleSearch, { personLabel } from "@/components/users/PeopleSearch";
import {
  apiFetch,
  isApiError,
  outcomeUnknown,
  type ApiPath,
} from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import type { TargetActivationEvent } from "@/lib/ui/targetActivation";
import type { ShareSession } from "@/lib/sharing/controller";
import type { CanonicalResourceRef, ShareMode } from "@/lib/sharing/types";
import { ClipboardWriteUnavailableError } from "@/lib/ui/copyText";
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

/** What the grant editor borrows from the panel: a change's outcome, and share. */
interface PanelActions {
  /** A change landed: an unknown outcome under the same key is settled. */
  landed: (key: string) => void;
  /** A change failed: refused, it speaks once; unknown, it holds until a read settles it. */
  fail: (error: unknown, key: string, fact: string) => void;
  nativeShare: (url: string, title: string) => Promise<boolean>;
}

/** A sharing change refused for a reason the server names. */
const SHARE_REASONS: Readonly<Record<string, string>> = { E_USER_NOT_FOUND: "this account no longer exists." };

function SharePanel({ session, onClose }: { session: ShareSession; onClose: () => void }) {
  const { target } = session;
  const outcome = useOutcome();
  // A failed read stands where the options would until a replacement read lands; over a shown
  // snapshot, a failed reread says nothing.
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  /** A change whose outcome is unknown: the snapshot's next read settles it. */
  const [unknown, setUnknown] = useState<{ key: string; attempt: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const reading = useRef<AbortSignal | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  // A defect found in a callback is rethrown while rendering, so the error boundary sees it.
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const workspace = useWorkspaceStore();

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
        setUnknown(null);
      } catch (error) {
        if (currentSignal.aborted || handleUnauthenticatedApiError(error)) return;
        setLoadError(error);
      } finally {
        if (reading.current === currentSignal) reading.current = null;
        if (!currentSignal.aborted) setLoading(false);
      }
    },
    [target],
  );

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (defect !== null) throw defect.error;

  const actions: PanelActions = {
    landed: key => setUnknown(current => current?.key === key ? null : current),
    fail: (error, key, fact) => {
      if (lifetime.current?.signal.aborted || handleUnauthenticatedApiError(error)) return;
      if (outcomeUnknown(error)) { setUnknown(current => ({ key, attempt: current?.key === key ? current.attempt + 1 : 0 })); return; }
      const reason = isApiError(error) ? SHARE_REASONS[error.code] : undefined;
      if (reason === undefined) outcome.fail(error, fact);
      else outcome.say({ fact, reason });
    },
    nativeShare: async (url, title) => {
      try {
        await navigator.share({ title, url });
        return true;
      } catch (error) {
        const expected = ["AbortError", "DataError", "InvalidStateError", "NotAllowedError"];
        if (!(error instanceof DOMException && expected.includes(error.name))) setDefect({ error });
        else if (error.name !== "AbortError") outcome.say({ fact: "couldn’t open the share menu." });
        return false;
      }
    },
  };

  const mode: ShareMode = target.kind === "Route" ? "CopyOnly" : (snapshot?.sharing ?? "None");
  const href =
    target.kind === "Route"
      ? new URL(target.href, session.origin).toString()
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
    <div className={styles.panel} tabIndex={-1}>
      {target.kind === "Resource" && !snapshot && loadError === null
        ? <Ruling />
        : <p className={styles.note}>{MODE_INTRO[mode]}</p>}
      <Section
        id="share-nexus-link"
        title="Nexus link"
        note={mode === "LibraryMembership" ? "Only members can open this link." : label}
        aside={
          <span className={styles.actions}>
            <ShareCopyButton href={href} label="Copy link" />
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
      {loadError !== null && snapshot === null ? isApiError(loadError) && loadError.status === 404
        ? <Fact line={{ fact: "this item is no longer available." }} />
        : <Failed error={loadError} noun="sharing options" retry={{ run: () => void load(), busy: loading }} /> : null}
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
      {unknown !== null ? <Hold id={`share-change:${unknown.key}`} attempt={unknown.attempt}
        line={{ fact: "not sure that saved.", reason: "it may have gone through." }}
        verbs={[{ label: "check", commandKey: "share-check", busy: loading, run: () => void load() }]} /> : null}
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
  // Keep an uncertain create's id until its receipt or an authoritative snapshot
  // confirms that exact grant. Later creates must never reuse a revoked grant id.
  const attempts = useRef(new Map<string, string>());
  useEffect(() => {
    for (const [key, id] of attempts.current) {
      if (snapshot.shares.some(share => share.id === id)) attempts.current.delete(key);
    }
  }, [snapshot.shares]);
  const link = snapshot.shares.find((s): s is Schema<"LinkShareOut"> => s.kind === "Link");
  const people = snapshot.shares.filter((s): s is Schema<"UserShareOut"> => s.kind === "User");
  const { user: userAvailability, link: linkAvailability } = snapshot.creation_availability;
  const includesHighlight = snapshot.sharing === "HighlightGrants";

  const create = async (
    audience: Schema<"CreateResourceShareRequest">["audience"],
    key: string,
    fact: string,
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
      actions.landed(key);
      return true;
    } catch (error) {
      actions.fail(error, key, fact);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (id: string, fact: string) => {
    setBusy(id);
    try {
      await apiFetch(`/api/resource-shares/${id}`, { method: "DELETE" });
      onChange({
        ...snapshot,
        shares: snapshot.shares.filter((share) => share.id !== id),
        received_access: snapshot.received_access.filter((share) => share.id !== id),
      });
      setConfirm(null);
      actions.landed(id);
    } catch (error) {
      actions.fail(error, id, fact);
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
    copy: { label: string; prompt: string; yes: string; no: string; failed: string },
  ) =>
    guarded(
      id,
      <Button tone="danger" disabled={busy !== null} onClick={() => setConfirm(id)}>
        {copy.label}
      </Button>,
      copy.prompt,
      [copy.yes, copy.no],
      () => void revoke(id, copy.failed),
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
              context={JSON.stringify(props.subject)}
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
                  `couldn’t share with ${name}.`,
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
              failed: `couldn’t remove ${personLabel(share.user)}’s share.`,
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
                failed: "couldn’t decline this share.",
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
              <ShareCopyButton href={link.public_href} label="Copy public link" />
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
              failed: "couldn’t turn off your public link.",
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
                "couldn’t turn on your public link.",
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

function ShareCopyButton({href, label}: {href: string | null; label: string}) {
  const copied = useCopyFeedback(href);
  const outcome = useOutcome();
  const [manual, setManual] = useState(false);
  useEffect(() => {setManual(false);}, [href]);
  const [defect, setDefect] = useState<{error: unknown} | null>(null);
  if (defect) throw defect.error;
  const copy = async () => {
    if (href === null) return;
    try {await copied.copy(href);}
    catch (error) {
      if (error instanceof ClipboardWriteUnavailableError)
        outcome.say({ fact: "couldn’t copy the link." }, [{ label: "show link", commandKey: `show-link:${href}`, run: () => setManual(true) }]);
      else setDefect({error});
    }
  };
  return <>
    <Button icon={copied.copied ? <Check /> : <Copy />} disabled={href === null} onClick={() => void copy()}>{label}</Button>
    {copied.occurrence ? <Announcement text="copied" level="Polite" occurrence={copied.occurrence} /> : null}
    <Dialog open={manual} title="copy link" onClose={() => setManual(false)} initialFocus={panel => panel.querySelector('textarea')}>
      <textarea readOnly aria-label="link to copy" value={href ?? ""} onFocus={event => event.currentTarget.select()} />
    </Dialog>
  </>;
}
