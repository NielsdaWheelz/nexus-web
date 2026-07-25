"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Copy, Send, Share2 } from "lucide-react";
import PeopleSearchCombobox from "@/components/users/PeopleSearchCombobox";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import MobileSheet from "@/components/ui/MobileSheet";
import { toFeedback } from "@/components/feedback/Feedback";
import { isSameSystemApiDefect } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { getMemberLibrary } from "@/lib/libraries/client";
import {
  LibraryContractDefect,
  isLibraryContractDefect,
  type LibraryOut,
} from "@/lib/libraries/contract";
import { requestOpenInAppPane } from "@/lib/panes/openInAppPane";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import {
  createLinkShare,
  createUserShare,
  deleteShare,
  fetchShareSnapshot,
} from "@/lib/sharing/api";
import {
  SHARE_MODE_INTRO,
  audienceUnavailableMessage,
} from "@/lib/sharing/content";
import type { ShareSession } from "@/lib/sharing/controller";
import { absoluteNexusHref } from "@/lib/sharing/targets";
import type {
  AudienceAvailability,
  OwnedShare,
  ShareMode,
  ShareSnapshot,
  ShareUserProjection,
} from "@/lib/sharing/types";
import {
  isUserSearchContractDefect,
  searchUsers,
  type UserSearchResult,
} from "@/lib/users/search";
import { copyText } from "@/lib/ui/copyText";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import styles from "./ShareOverlay.module.css";

interface ShareOverlayProps {
  session: ShareSession | null;
  onClose: () => void;
}

type LoadState =
  | { kind: "Idle" }
  | { kind: "Loading" }
  | { kind: "Ready"; snapshot: ShareSnapshot }
  | { kind: "Error"; message: string };

type LibraryCapabilityState =
  | { kind: "Idle" }
  | { kind: "Loading" }
  | { kind: "Ready"; library: LibraryOut }
  | { kind: "Error"; message: string };

function nativeShareAvailable(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof (navigator as Navigator & { share?: unknown }).share === "function"
  );
}

function returnFocusFallback(session: ShareSession | null) {
  const fallback = session?.options.returnFocusFallback;
  return fallback?.kind === "Present" ? fallback.value : undefined;
}

function librarySubjectId(snapshot: ShareSnapshot): string {
  const ref = parseResourceRef(snapshot.subject);
  if (!ref || ref.scheme !== "library") {
    // justify-defect: LibraryMembership is valid only for a canonical library
    // subject; member-management activation cannot target another resource.
    throw new LibraryContractDefect(
      "Library sharing received a non-library subject",
    );
  }
  return ref.id;
}

export default function ShareOverlay({ session, onClose }: ShareOverlayProps) {
  const isMobile = useIsMobileViewport();
  const active = session !== null;
  const content = session ? (
    <SharePanel key={session.key} session={session} onClose={onClose} />
  ) : null;

  return (
    <>
      <Dialog
        open={active && !isMobile}
        onClose={onClose}
        title="Share"
        returnFocusTo={session?.options.returnFocusTo}
        returnFocusFallback={returnFocusFallback(session)}
      >
        {content}
      </Dialog>
      <MobileSheet
        active={active && isMobile}
        onDismiss={onClose}
        ariaLabel="Share"
        panelId="share-sheet"
        returnFocusTo={session?.options.returnFocusTo}
        returnFocusFallback={returnFocusFallback(session)}
      >
        <div className={styles.mobileHeader}>
          <h2>Share</h2>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Done
          </Button>
        </div>
        {content}
      </MobileSheet>
    </>
  );
}

function SharePanel({
  session,
  onClose,
}: {
  session: ShareSession;
  onClose: () => void;
}) {
  const { target } = session;
  const [loadState, setLoadState] = useState<LoadState>(
    target.kind === "Route" ? { kind: "Idle" } : { kind: "Loading" },
  );
  const [liveMessage, setLiveMessage] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [libraryCapability, setLibraryCapability] =
    useState<LibraryCapabilityState>({ kind: "Idle" });
  const [asyncDefect, setAsyncDefect] = useState<unknown>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (target.kind === "Route") return;
      setLoadState({ kind: "Loading" });
      try {
        const snapshot = await fetchShareSnapshot(target.ref, signal);
        setLoadState({ kind: "Ready", snapshot });
      } catch (error) {
        if (signal?.aborted || handleUnauthenticatedApiError(error)) return;
        if (isSameSystemApiDefect(error)) {
          setAsyncDefect(error);
          return;
        }
        setLoadState({
          kind: "Error",
          message: toFeedback(error, {
            fallback: "Sharing could not be loaded.",
          }).title,
        });
      }
    },
    [target],
  );

  useEffect(() => {
    if (target.kind === "Route") return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, target.kind]);

  const snapshot = loadState.kind === "Ready" ? loadState.snapshot : null;
  const mode: ShareMode =
    target.kind === "Route" ? "CopyOnly" : (snapshot?.sharing ?? "None");
  const nexusHref =
    target.kind === "Route"
      ? absoluteNexusHref(target.href)
      : (snapshot?.authenticatedHref ?? null);
  const label =
    target.kind === "Route"
      ? target.label
      : snapshot
        ? `${snapshot.subject.slice(0, snapshot.subject.indexOf(":"))} link`
        : "Nexus link";
  const libraryId = useMemo(
    () =>
      snapshot?.sharing === "LibraryMembership"
        ? librarySubjectId(snapshot)
        : null,
    [snapshot],
  );

  const loadLibraryCapability = useCallback(
    async (signal?: AbortSignal) => {
      if (libraryId === null) {
        setLibraryCapability({ kind: "Idle" });
        return;
      }
      setLibraryCapability({ kind: "Loading" });
      try {
        setLibraryCapability({
          kind: "Ready",
          library: await getMemberLibrary(libraryId, signal),
        });
      } catch (error) {
        if (signal?.aborted || handleUnauthenticatedApiError(error)) return;
        if (
          isLibraryContractDefect(error) ||
          isSameSystemApiDefect(error)
        ) {
          setAsyncDefect(error);
          return;
        }
        setLibraryCapability({
          kind: "Error",
          message: toFeedback(error, {
            fallback: "Member-management access could not be checked.",
          }).title,
        });
      }
    },
    [libraryId],
  );

  useEffect(() => {
    if (libraryId === null) {
      setLibraryCapability({ kind: "Idle" });
      return;
    }
    const controller = new AbortController();
    void loadLibraryCapability(controller.signal);
    return () => controller.abort();
  }, [libraryId, loadLibraryCapability]);

  const announce = useCallback((message: string) => {
    setActionError(null);
    setLiveMessage("");
    requestAnimationFrame(() => setLiveMessage(message));
  }, []);

  const reportActionError = useCallback((error: unknown, fallback: string) => {
    if (handleUnauthenticatedApiError(error)) return;
    setLiveMessage("");
    setActionError(toFeedback(error, { fallback }).title);
  }, []);

  const handleCopy = useCallback(
    async (href: string, copiedLabel: string) => {
      try {
        await copyText(href);
        announce(`${copiedLabel} copied.`);
      } catch (error) {
        reportActionError(error, "The link could not be copied. Try again.");
      }
    },
    [announce, reportActionError],
  );

  const handleNativeShare = useCallback(
    async (href: string, title: string) => {
      if (!navigator.share) return false;
      try {
        await navigator.share({ title, url: href });
        return true;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return false;
        }
        reportActionError(error, "The share menu could not be opened.");
        return false;
      }
    },
    [reportActionError],
  );

  const handleManageMembers = useCallback(() => {
    if (!snapshot || snapshot.sharing !== "LibraryMembership") return;
    const accepted = requestOpenInAppPane(snapshot.authenticatedHref, {
      secondaryActivation: {
        kind: "Surface",
        surfaceId: "resource-members",
      },
    });
    if (accepted) {
      onClose();
      return;
    }
    setLiveMessage("");
    setActionError("Members could not be opened. Try again.");
  }, [onClose, snapshot]);

  if (asyncDefect) throw asyncDefect;

  return (
    <div className={styles.panel}>
      <p className={styles.intro}>
        {target.kind === "Resource" && loadState.kind === "Loading"
          ? "Loading sharing options…"
          : SHARE_MODE_INTRO[mode]}
      </p>

      <section className={styles.section} aria-labelledby="share-nexus-link">
        <div className={styles.sectionHeading}>
          <div>
            <h3 id="share-nexus-link">Nexus link</h3>
            <p>
              {mode === "LibraryMembership"
                ? "Only members can open this link."
                : label}
            </p>
          </div>
          <div className={styles.actions}>
            <Button
              variant="secondary"
              size="sm"
              leadingIcon={<Copy size={15} />}
              disabled={!nexusHref}
              onClick={() =>
                nexusHref && void handleCopy(nexusHref, "Nexus link")
              }
            >
              Copy link
            </Button>
            {nativeShareAvailable() ? (
              <Button
                variant="secondary"
                size="sm"
                leadingIcon={<Share2 size={15} />}
                disabled={!nexusHref}
                onClick={() =>
                  nexusHref && void handleNativeShare(nexusHref, label)
                }
              >
                Share
              </Button>
            ) : null}
          </div>
        </div>
      </section>

      {loadState.kind === "Error" ? (
        <div className={styles.error} role="alert">
          <span>{loadState.message}</span>
          <Button variant="secondary" size="sm" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      ) : null}

      {snapshot && (mode === "ResourceGrants" || mode === "HighlightGrants") ? (
        <GrantEditor
          snapshot={snapshot}
          onSnapshotChange={(next) =>
            setLoadState({ kind: "Ready", snapshot: next })
          }
          onCopy={handleCopy}
          onNativeShare={handleNativeShare}
          announce={announce}
          reportError={reportActionError}
          reportDefect={setAsyncDefect}
        />
      ) : null}

      {snapshot &&
      mode === "LibraryMembership" &&
      !(
        libraryCapability.kind === "Ready" &&
        (libraryCapability.library.isDefault ||
          libraryCapability.library.systemKey !== null)
      ) ? (
        <section
          className={styles.section}
          aria-labelledby="share-library-members"
        >
          <div className={styles.sectionHeading}>
            <div>
              <h3 id="share-library-members">People</h3>
              {libraryCapability.kind === "Ready" &&
              !libraryCapability.library.isDefault &&
              libraryCapability.library.systemKey === null ? (
                <p>
                  {libraryCapability.library.canManageMembers
                    ? "Manage people, invitations, roles, and ownership in the Library pane."
                    : "Members are managed by library admins."}
                </p>
              ) : libraryCapability.kind === "Loading" ? (
                <p role="status">Checking member-management access…</p>
              ) : null}
            </div>
            {libraryCapability.kind === "Ready" &&
            libraryCapability.library.canManageMembers ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={handleManageMembers}
              >
                Manage members
              </Button>
            ) : null}
          </div>
          {libraryCapability.kind === "Error" ? (
            <div className={styles.error} role="alert">
              <span>{libraryCapability.message}</span>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void loadLibraryCapability()}
              >
                Retry
              </Button>
            </div>
          ) : null}
        </section>
      ) : null}

      {actionError ? (
        <div className={styles.error} role="alert">
          {actionError}
        </div>
      ) : null}
      <div
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {liveMessage}
      </div>
    </div>
  );
}

function AvailabilityNote({
  availability,
}: {
  availability: AudienceAvailability;
}) {
  return availability.kind === "Unavailable" ? (
    <p className={styles.availability}>
      {audienceUnavailableMessage(availability.reason)}
    </p>
  ) : null;
}

function shareUserLabel(user: ShareUserProjection): string {
  return user.displayName ?? user.email ?? user.userHandle;
}

function userSearchLabel(user: UserSearchResult): string {
  return user.displayName.kind === "Present"
    ? user.displayName.value
    : user.email.kind === "Present"
      ? user.email.value
      : user.userHandle;
}

function upsertOwnedShare(
  shares: readonly OwnedShare[],
  next: OwnedShare,
): OwnedShare[] {
  const index = shares.findIndex((share) => share.handle === next.handle);
  if (index < 0) return [...shares, next];
  return shares.map((share, currentIndex) =>
    currentIndex === index ? next : share,
  );
}

function GrantEditor({
  snapshot,
  onSnapshotChange,
  onCopy,
  onNativeShare,
  announce,
  reportError,
  reportDefect,
}: {
  snapshot: ShareSnapshot;
  onSnapshotChange: (snapshot: ShareSnapshot) => void;
  onCopy: (href: string, label: string) => Promise<void>;
  onNativeShare: (href: string, title: string) => Promise<boolean>;
  announce: (message: string) => void;
  reportError: (error: unknown, fallback: string) => void;
  reportDefect: (error: unknown) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<UserSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [busyHandle, setBusyHandle] = useState<string | null>(null);
  const [confirmHandle, setConfirmHandle] = useState<string | null>(null);
  const [confirmNative, setConfirmNative] = useState(false);
  const [nativeSharing, setNativeSharing] = useState(false);
  const [confirmX, setConfirmX] = useState(false);
  const searchSequence = useRef(0);
  const publicShare = snapshot.shares.find(
    (share): share is Extract<OwnedShare, { kind: "Link" }> =>
      share.kind === "Link",
  );
  const userShares = snapshot.shares.filter(
    (share): share is Extract<OwnedShare, { kind: "User" }> =>
      share.kind === "User",
  );

  useEffect(() => {
    const trimmed = query.trim();
    const sequence = ++searchSequence.current;
    if (trimmed.length < 3) {
      setResults([]);
      setSearching(false);
      return;
    }
    setResults([]);
    setSearching(false);
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setSearching(true);
      try {
        const next = await searchUsers(trimmed, controller.signal);
        if (searchSequence.current === sequence) setResults(next);
      } catch (error) {
        if (!controller.signal.aborted) {
          if (isUserSearchContractDefect(error)) {
            reportDefect(error);
            return;
          }
          reportError(error, "People could not be searched.");
        }
      } finally {
        if (searchSequence.current === sequence) setSearching(false);
      }
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, reportDefect, reportError]);

  const addUser = async (user: UserSearchResult) => {
    if (busyHandle !== null) return;
    setBusyHandle(user.userHandle);
    try {
      const result = await createUserShare({
        ref: snapshot.subject,
        userHandle: user.userHandle,
      });
      if (result.share.kind !== "User") {
        throw new Error("User sharing returned a non-user share");
      }
      const shares = upsertOwnedShare(snapshot.shares, result.share);
      onSnapshotChange({ ...snapshot, shares });
      setQuery("");
      setResults([]);
      announce(
        result.created
          ? `Shared with ${userSearchLabel(user)}.`
          : `${userSearchLabel(user)} already has this share.`,
      );
    } catch (error) {
      reportError(error, "Access could not be shared.");
    } finally {
      setBusyHandle(null);
    }
  };

  const remove = async (share: OwnedShare) => {
    if (busyHandle !== null) return;
    setBusyHandle(share.handle);
    try {
      await deleteShare(share.handle);
      onSnapshotChange({
        ...snapshot,
        shares: snapshot.shares.filter((row) => row.handle !== share.handle),
      });
      setConfirmHandle(null);
      announce(
        share.kind === "Link"
          ? "Your public link was turned off."
          : `Removed the share for ${shareUserLabel(share.user)}.`,
      );
    } catch (error) {
      reportError(error, "The share could not be removed.");
    } finally {
      setBusyHandle(null);
    }
  };

  const turnOnPublicLink = async () => {
    if (busyHandle !== null) return;
    setBusyHandle("new-link");
    try {
      const result = await createLinkShare(snapshot.subject);
      if (result.share.kind !== "Link") {
        throw new Error("Public-link sharing returned a non-link share");
      }
      onSnapshotChange({
        ...snapshot,
        shares: upsertOwnedShare(snapshot.shares, result.share),
      });
      announce(
        result.created
          ? "Your public link is on."
          : "Your public link was already on.",
      );
    } catch (error) {
      reportError(error, "Your public link could not be turned on.");
    } finally {
      setBusyHandle(null);
    }
  };

  return (
    <>
      <section className={styles.section} aria-labelledby="share-your-shares">
        <div className={styles.sectionHeading}>
          <div>
            <h3 id="share-your-shares">Your shares</h3>
            <p>
              Direct shares you created. Your notes and other highlights stay
              private.
            </p>
          </div>
        </div>
        {snapshot.creationAvailability.user.kind === "Available" ? (
          <>
            <p className={styles.audienceDisclosure}>
              This person can read and reshare the media. They may already have
              access another way.
              {snapshot.sharing === "HighlightGrants"
                ? " This share also includes this exact highlight and its source media."
                : ""}
            </p>
            <PeopleSearchCombobox
              label="Search people to share with"
              placeholder="Search people…"
              query={query}
              results={results}
              searching={searching}
              disabled={busyHandle !== null}
              onQueryChange={setQuery}
              onSelect={(user) => void addUser(user)}
            />
          </>
        ) : (
          <AvailabilityNote availability={snapshot.creationAvailability.user} />
        )}

        <div className={styles.rows}>
          {userShares.length === 0 ? (
            <p className={styles.empty}>You have not shared this directly.</p>
          ) : (
            userShares.map((share) => (
              <div key={share.handle} className={styles.row}>
                <span>{shareUserLabel(share.user)}</span>
                {confirmHandle === share.handle ? (
                  <span className={styles.confirm}>
                    <span>Remove only this direct share?</span>
                    <Button
                      variant="danger"
                      size="sm"
                      loading={busyHandle === share.handle}
                      onClick={() => void remove(share)}
                    >
                      Remove
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busyHandle !== null}
                      onClick={() => setConfirmHandle(null)}
                    >
                      Keep
                    </Button>
                  </span>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busyHandle !== null}
                    onClick={() => setConfirmHandle(share.handle)}
                  >
                    Remove
                  </Button>
                )}
              </div>
            ))
          )}
        </div>
      </section>

      {snapshot.receivedAccess.length > 0 ? (
        <section className={styles.section} aria-labelledby="share-received">
          <div className={styles.sectionHeading}>
            <div>
              <h3 id="share-received">Shared with you</h3>
              <p>Declining removes only the access path shown here.</p>
            </div>
          </div>
          <div className={styles.rows}>
            {snapshot.receivedAccess.map((share) => (
              <div key={share.handle} className={styles.row}>
                <span>
                  {shareUserLabel(share.sharedBy)} shared this{" "}
                  {share.subject.startsWith("highlight:")
                    ? "highlight"
                    : "media"}
                </span>
                {confirmHandle === share.handle ? (
                  <span className={styles.confirm}>
                    <span>Decline only this access path?</span>
                    <Button
                      variant="danger"
                      size="sm"
                      loading={busyHandle === share.handle}
                      onClick={async () => {
                        if (busyHandle !== null) return;
                        setBusyHandle(share.handle);
                        try {
                          await deleteShare(share.handle);
                          onSnapshotChange({
                            ...snapshot,
                            receivedAccess: snapshot.receivedAccess.filter(
                              (row) => row.handle !== share.handle,
                            ),
                          });
                          setConfirmHandle(null);
                          announce("This shared access path was declined.");
                        } catch (error) {
                          reportError(
                            error,
                            "The shared access could not be declined.",
                          );
                        } finally {
                          setBusyHandle(null);
                        }
                      }}
                    >
                      Decline
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busyHandle !== null}
                      onClick={() => setConfirmHandle(null)}
                    >
                      Keep
                    </Button>
                  </span>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busyHandle !== null}
                    onClick={() => setConfirmHandle(share.handle)}
                  >
                    Decline
                  </Button>
                )}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className={styles.section} aria-labelledby="share-public-link">
        <div className={styles.sectionHeading}>
          <div>
            <h3 id="share-public-link">Your public link</h3>
            <p>
              Anyone with this link can read the media and may share it again.
              Turning this off revokes only your link; it cannot revoke copies
              or other access paths. Your notes and other highlights stay
              private.
              {snapshot.sharing === "HighlightGrants"
                ? " This highlight is included."
                : ""}
            </p>
          </div>
          <span className={styles.state}>
            {publicShare ? "Unlisted · On" : "Off"}
          </span>
        </div>
        {publicShare ? (
          <>
            <div className={styles.actions}>
              <Button
                variant="secondary"
                size="sm"
                leadingIcon={<Copy size={15} />}
                onClick={() =>
                  void onCopy(publicShare.publicHref, "Public link")
                }
              >
                Copy public link
              </Button>
              {nativeShareAvailable() ? (
                <Button
                  variant="secondary"
                  size="sm"
                  leadingIcon={<Share2 size={15} />}
                  onClick={() => setConfirmNative(true)}
                >
                  Share public link
                </Button>
              ) : null}
              <Button
                variant="secondary"
                size="sm"
                leadingIcon={<Send size={15} />}
                onClick={() => setConfirmX(true)}
              >
                Post to X
              </Button>
            </div>
            {confirmNative ? (
              <div className={styles.warning}>
                <p>
                  Sharing sends this bearer link to the app you choose. That
                  destination gains read access and may retain the credential.
                </p>
                <div className={styles.actions}>
                  <Button
                    variant="primary"
                    size="sm"
                    loading={nativeSharing}
                    onClick={async () => {
                      setNativeSharing(true);
                      try {
                        const shared = await onNativeShare(
                          publicShare.publicHref,
                          "Shared from Nexus",
                        );
                        if (shared) setConfirmNative(false);
                      } finally {
                        setNativeSharing(false);
                      }
                    }}
                  >
                    Continue to share
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={nativeSharing}
                    onClick={() => setConfirmNative(false)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}
            {confirmX ? (
              <div className={styles.warning}>
                <p>
                  Posting sends this bearer link to X. X gains read access and
                  may retain the credential. Posting also makes an unlisted link
                  effectively published.
                </p>
                <div className={styles.actions}>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => {
                      const opened = window.open(
                        `https://x.com/intent/post?url=${encodeURIComponent(
                          publicShare.publicHref,
                        )}`,
                        "_blank",
                        "noopener,noreferrer",
                      );
                      if (opened) {
                        setConfirmX(false);
                      } else {
                        reportError(
                          null,
                          "X could not be opened. Check your popup settings and try again.",
                        );
                      }
                    }}
                  >
                    Continue to X
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setConfirmX(false)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}
            {confirmHandle === publicShare.handle ? (
              <div className={styles.warning}>
                <p>
                  Turn off only your public link? Existing copies and other
                  access paths are unaffected.
                </p>
                <div className={styles.actions}>
                  <Button
                    variant="danger"
                    size="sm"
                    loading={busyHandle === publicShare.handle}
                    onClick={() => void remove(publicShare)}
                  >
                    Turn off
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busyHandle !== null}
                    onClick={() => setConfirmHandle(null)}
                  >
                    Keep on
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                disabled={busyHandle !== null}
                onClick={() => setConfirmHandle(publicShare.handle)}
              >
                Turn off public link
              </Button>
            )}
          </>
        ) : snapshot.creationAvailability.link.kind === "Available" ? (
          <Button
            variant="secondary"
            size="sm"
            loading={busyHandle === "new-link"}
            disabled={busyHandle !== null}
            onClick={() => void turnOnPublicLink()}
          >
            Turn on public link
          </Button>
        ) : (
          <AvailabilityNote availability={snapshot.creationAvailability.link} />
        )}
        <p className={styles.rights}>
          Only share content you may redistribute.
        </p>
      </section>
    </>
  );
}
