"use client";

import { useCallback, useEffect, useState, type ComponentProps, type ReactNode } from "react";
import { Copy, Send, Share2 } from "lucide-react";
import { FeedbackNotice, type FeedbackContent } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import MobileSheet from "@/components/ui/MobileSheet";
import PeopleSearchCombobox from "@/components/users/PeopleSearchCombobox";
import {
  apiCommand204,
  apiFetch,
  apiTransportFeedback,
  isApiError,
  isSameSystemApiDefect,
  type ApiPath,
} from "@/lib/api/client";
import { useDebouncedFetch } from "@/lib/api/useDebouncedFetch";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import type { ShareSession } from "@/lib/sharing/controller";
import type { CanonicalResourceRef, ShareMode } from "@/lib/sharing/types";
import { ClipboardWriteUnavailableError, copyText } from "@/lib/ui/copyText";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { searchUsers } from "@/lib/users/search";
import { useWorkspaceStore } from "@/lib/workspace/store";
import styles from "./ShareOverlay.module.css";

type Snapshot = Schema<"ResourceShareSnapshotOut">;
type Person = Pick<Schema<"ShareUserOut">, "userHandle" | "email" | "displayName">;
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

function personLabel(person: Person): string {
  if (person.displayName.kind === "Present") return person.displayName.value;
  return person.email.kind === "Present" ? person.email.value : person.userHandle;
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
  const fallback = session?.options.returnFocusFallback;
  const focus = {
    returnFocusTo: session?.options.returnFocusTo,
    returnFocusFallback: fallback?.kind === "Present" ? fallback.value : undefined,
  };
  const panel = session && <SharePanel key={session.key} session={session} onClose={onClose} />;
  return (
    <>
      <Dialog open={session !== null && !isMobile} onClose={onClose} title="Share" {...focus}>
        {panel}
      </Dialog>
      <MobileSheet
        active={session !== null && isMobile}
        onDismiss={onClose}
        ariaLabel="Share"
        panelId="share-sheet"
        {...focus}
      >
        <div className={styles.mobileHeader}>
          <h2>Share</h2>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Done
          </Button>
        </div>
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
  // Loading until one of these is set; Retry clears the error.
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loadError, setLoadError] = useState<FeedbackContent | null>(null);
  const [liveMessage, setLiveMessage] = useState("");
  const [actionError, setActionError] = useState<FeedbackContent | null>(null);
  // A defect found in a callback is rethrown while rendering, so the error boundary sees it.
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const workspace = useWorkspaceStore();

  const explain = useCallback((error: unknown, title: string, mutation: boolean) => {
    try {
      return feedbackFor(error, title, mutation);
    } catch (thrown) {
      setDefect({ error: thrown });
      return null;
    }
  }, []);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (target.kind === "Route") return;
      setLoadError(null);
      try {
        setSnapshot((await apiFetch<SharesJson<"get">>(sharesPath(target.ref), { signal })).data);
      } catch (error) {
        if (signal?.aborted) return;
        setLoadError(explain(error, "Sharing options couldn’t be loaded.", false));
      }
    },
    [explain, target],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (defect !== null) throw defect.error;

  const showError = (content: FeedbackContent | null) => {
    if (!content) return;
    setLiveMessage("");
    setActionError(content);
  };
  const actions: PanelActions = {
    announce: (message) => {
      setActionError(null);
      setLiveMessage("");
      requestAnimationFrame(() => setLiveMessage(message));
    },
    fail: (error, title) => showError(explain(error, title, true)),
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
      : (snapshot?.authenticatedHref ?? null);
  const label = target.kind === "Route" ? target.label : `${target.ref.split(":")[0]} link`;
  const members = snapshot?.members.kind === "Present" ? snapshot.members.value : null;

  const manageMembers = () => {
    if (!snapshot) return;
    const result = workspace.activateWorkspaceTarget({
      originPaneId: workspace.state.activePrimaryPaneId,
      target: {
        href: snapshot.authenticatedHref,
        secondaryActivation: { surfaceId: "resource-members" },
      },
      disposition: { kind: "Follow" },
    });
    if (result.kind !== "Rejected") onClose();
    else showError({ tone: "Danger", title: "Members could not be opened. Try again." });
  };

  return (
    <div className={styles.panel}>
      <p className={styles.note}>
        {target.kind === "Resource" && !snapshot && !loadError
          ? "Loading sharing options…"
          : MODE_INTRO[mode]}
      </p>
      <Section
        id="share-nexus-link"
        title="Nexus link"
        note={mode === "LibraryMembership" ? "Only members can open this link." : label}
        aside={
          <span className={styles.actions}>
            <Small
              icon={<Copy size={15} />}
              disabled={!href}
              onClick={() => href && void actions.copy(href, "Nexus link")}
            >
              Copy link
            </Small>
            {typeof navigator.share === "function" ? (
              <Small
                icon={<Share2 size={15} />}
                disabled={!href}
                onClick={() => href && void actions.nativeShare(href, label)}
              >
                Share
              </Small>
            ) : null}
          </span>
        }
      />
      {loadError ? (
        <FeedbackNotice
          content={loadError}
          announcement="Assertive"
          actions={[{ label: "Retry", onClick: () => void load() }]}
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
            members.canManage
              ? "Manage people, invitations, roles, and ownership in the Library pane."
              : "Members are managed by library admins."
          }
          aside={members.canManage ? <Small onClick={manageMembers}>Manage members</Small> : null}
        />
      ) : null}
      {actionError ? <FeedbackNotice content={actionError} announcement="Assertive" /> : null}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {liveMessage}
      </div>
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

function Small({ icon, ...props }: ComponentProps<typeof Button> & { icon?: ReactNode }) {
  return <Button variant="secondary" size="sm" leadingIcon={icon} {...props} />;
}

function GrantEditor(props: {
  subject: CanonicalResourceRef;
  snapshot: Snapshot;
  onChange: (snapshot: Snapshot) => void;
  actions: PanelActions;
}) {
  const { snapshot, onChange, actions } = props;
  const [query, setQuery] = useState("");
  // One change at a time: `busy` names the change in flight and disables every other one.
  const [busy, setBusy] = useState<string | null>(null);
  // One question at a time: a grant's handle, or "Native" / "X" for a bearer-link warning.
  const [confirm, setConfirm] = useState<string | null>(null);
  const trimmed = query.trim();
  const searchKey = trimmed.length >= 3 ? trimmed : null;
  const search = useDebouncedFetch(searchKey, (signal) => searchUsers(trimmed, signal), {
    debounceMs: 250,
  });
  const searchFailed = search.error !== null && search.errorIdentity === searchKey;
  if (searchFailed && (!isApiError(search.error) || isSameSystemApiDefect(search.error))) {
    throw search.error;
  }
  const link = snapshot.shares.find((s): s is Schema<"LinkShareOut"> => s.kind === "Link");
  const people = snapshot.shares.filter((s): s is Schema<"UserShareOut"> => s.kind === "User");
  const { user: userAvailability, link: linkAvailability } = snapshot.creationAvailability;
  const includesHighlight = snapshot.sharing === "HighlightGrants";

  const create = async (
    audience: Schema<"CreateResourceShareRequest">["audience"],
    key: string,
    [created, existing]: [string, string],
    errorTitle: string,
  ) => {
    setBusy(key);
    try {
      const { data } = await apiFetch<SharesJson<"post">>(sharesPath(props.subject), {
        method: "POST",
        body: JSON.stringify({ audience }),
      });
      const known = snapshot.shares.some((share) => share.handle === data.share.handle);
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

  const revoke = async (handle: string, message: string, errorTitle: string) => {
    setBusy(handle);
    try {
      await apiCommand204(`/api/resource-shares/${encodeURIComponent(handle)}`, {
        method: "DELETE",
      });
      onChange({
        ...snapshot,
        shares: snapshot.shares.filter((share) => share.handle !== handle),
        receivedAccess: snapshot.receivedAccess.filter((share) => share.handle !== handle),
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
    variant: "danger" | "primary" = "danger",
  ) =>
    confirm !== key ? (
      trigger
    ) : (
      <span className={styles.confirm}>
        <span>{prompt}</span>
        <Button
          variant={variant}
          size="sm"
          loading={busy === key}
          disabled={busy !== null}
          onClick={onYes}
        >
          {yes}
        </Button>
        <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => setConfirm(null)}>
          {no}
        </Button>
      </span>
    );

  /** Remove, Decline or Turn off: a ghost button that asks, then deletes the grant. */
  const revocation = (
    handle: string,
    copy: { label: string; prompt: string; yes?: string; no: string; done: string; failed: string },
  ) =>
    guarded(
      handle,
      <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => setConfirm(handle)}>
        {copy.label}
      </Button>,
      copy.prompt,
      [copy.yes ?? copy.label, copy.no],
      () => void revoke(handle, copy.done, copy.failed),
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
            <PeopleSearchCombobox
              label="Search people to share with"
              placeholder="Search people…"
              status={searchFailed ? "People could not be searched." : undefined}
              query={query}
              results={search.dataIdentity === searchKey ? (search.data ?? []) : []}
              searching={searchKey !== null && search.loading}
              disabled={busy !== null}
              onQueryChange={setQuery}
              onSelect={(person) => {
                const name = personLabel(person);
                void create(
                  { kind: "User", userHandle: person.userHandle },
                  person.userHandle,
                  [`Shared with ${name}.`, `${name} already has this share.`],
                  "Access could not be shared.",
                ).then((created) => created && setQuery(""));
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
          <div key={share.handle} className={styles.row}>
            <span>{personLabel(share.user)}</span>
            {revocation(share.handle, {
              label: "Remove",
              prompt: "Remove only this direct share?",
              no: "Keep",
              done: `Removed the share for ${personLabel(share.user)}.`,
              failed: "The share could not be removed.",
            })}
          </div>
        ))}
      </Section>

      {snapshot.receivedAccess.length > 0 ? (
        <Section
          id="share-received"
          title="Shared with you"
          note="Declining removes only the access path shown here."
        >
          {snapshot.receivedAccess.map((share) => (
            <div key={share.handle} className={styles.row}>
              <span>
                {personLabel(share.sharedBy)} shared this {share.subject.split(":")[0]}
              </span>
              {revocation(share.handle, {
                label: "Decline",
                prompt: "Decline only this access path?",
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
              <Small
                icon={<Copy size={15} />}
                onClick={() => void actions.copy(link.publicHref, "Public link")}
              >
                Copy public link
              </Small>
              {typeof navigator.share === "function"
                ? guarded(
                    "Native",
                    <Small icon={<Share2 size={15} />} onClick={() => setConfirm("Native")}>
                      Share public link
                    </Small>,
                    "Sharing sends this bearer link to the app you choose. That destination gains read access and may retain the credential.",
                    ["Continue to share", "Cancel"],
                    async () => {
                      setBusy("Native");
                      const shared = actions.nativeShare(link.publicHref, "Shared from Nexus");
                      if (await shared) setConfirm(null);
                      setBusy(null);
                    },
                    "primary",
                  )
                : null}
              {guarded(
                "X",
                <Small icon={<Send size={15} />} onClick={() => setConfirm("X")}>
                  Post to X
                </Small>,
                "Posting sends this bearer link to X. X gains read access and may retain the credential. Posting also makes an unlisted link effectively published.",
                ["Continue to X", "Cancel"],
                () => {
                  // With noopener, window.open returns null whether or not the tab opened.
                  const intent = `https://x.com/intent/post?url=${encodeURIComponent(link.publicHref)}`;
                  window.open(intent, "_blank", "noopener,noreferrer");
                  setConfirm(null);
                },
                "primary",
              )}
            </span>
            {revocation(link.handle, {
              label: "Turn off public link",
              prompt:
                "Turn off only your public link? Existing copies and other access paths are unaffected.",
              yes: "Turn off",
              no: "Keep on",
              done: "Your public link was turned off.",
              failed: "The share could not be removed.",
            })}
          </>
        ) : linkAvailability.kind === "Available" ? (
          <Small
            loading={busy === "new-link"}
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
          </Small>
        ) : (
          <p className={styles.note}>{UNAVAILABLE[linkAvailability.reason]}</p>
        )}
        <p className={styles.note}>Only share content you may redistribute.</p>
      </Section>
    </>
  );
}
