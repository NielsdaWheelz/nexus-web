"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Copy, Send, Share2 } from "lucide-react";
import LibraryEntryEditor from "@/components/sharing/LibraryEntryEditor";
import LibraryMemberEditor from "@/components/sharing/LibraryMemberEditor";
import PeopleSearchCombobox from "@/components/sharing/PeopleSearchCombobox";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import MobileSheet from "@/components/ui/MobileSheet";
import { toFeedback } from "@/components/feedback/Feedback";
import {
  addPodcastToLibrary,
  fetchPodcastLibraries,
  removePodcastFromLibrary,
} from "@/app/(authenticated)/podcasts/podcastSubscriptions";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { useLibraryMembership } from "@/lib/media/useLibraryMembership";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import {
  createLinkShare,
  createUserShare,
  deleteShare,
  fetchShareSnapshot,
  searchShareUsers,
} from "@/lib/sharing/api";
import { SHARE_MODE_INTRO, audienceUnavailableMessage } from "@/lib/sharing/content";
import type { ShareSession } from "@/lib/sharing/controller";
import { absoluteNexusHref } from "@/lib/sharing/targets";
import type {
  AudienceAvailability,
  OwnedShare,
  ShareMode,
  ShareSnapshot,
  ShareUserProjection,
} from "@/lib/sharing/types";
import { copyText } from "@/lib/ui/copyText";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import type { LibraryTargetPickerItem } from "@/lib/media/mediaLibraries";
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

export default function ShareOverlay({
  session,
  onClose,
}: ShareOverlayProps) {
  const isMobile = useIsMobileViewport();
  const active = session !== null;
  const content = session ? (
    <SharePanel key={session.key} session={session} />
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

function SharePanel({ session }: { session: ShareSession }) {
  const { target } = session;
  const [loadState, setLoadState] = useState<LoadState>(
    target.kind === "Route" ? { kind: "Idle" } : { kind: "Loading" },
  );
  const [liveMessage, setLiveMessage] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (target.kind === "Route") return;
      setLoadState({ kind: "Loading" });
      try {
        const snapshot = await fetchShareSnapshot(target.ref, signal);
        setLoadState({ kind: "Ready", snapshot });
      } catch (error) {
        if (signal?.aborted || handleUnauthenticatedApiError(error)) return;
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

  const snapshot =
    loadState.kind === "Ready" ? loadState.snapshot : null;
  const mode: ShareMode =
    target.kind === "Route" ? "CopyOnly" : (snapshot?.sharing ?? "None");
  const nexusHref =
    target.kind === "Route"
      ? absoluteNexusHref(target.href)
      : snapshot?.authenticatedHref ?? null;
  const label =
    target.kind === "Route"
      ? target.label
      : snapshot
        ? `${snapshot.subject.slice(0, snapshot.subject.indexOf(":"))} link`
        : "Nexus link";

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
            <p>{mode === "LibraryMembership" ? "Only members can open this link." : label}</p>
          </div>
          <div className={styles.actions}>
            <Button
              variant="secondary"
              size="sm"
              leadingIcon={<Copy size={15} />}
              disabled={!nexusHref}
              onClick={() => nexusHref && void handleCopy(nexusHref, "Nexus link")}
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

      {snapshot &&
      (mode === "ResourceGrants" || mode === "HighlightGrants") ? (
        <GrantEditor
          snapshot={snapshot}
          onSnapshotChange={(next) =>
            setLoadState({ kind: "Ready", snapshot: next })
          }
          onCopy={handleCopy}
          onNativeShare={handleNativeShare}
          announce={announce}
          reportError={reportActionError}
        />
      ) : null}

      {snapshot && mode === "LibraryMembership" ? (
        <section className={styles.section} aria-labelledby="share-library-members">
          <div className={styles.sectionHeading}>
            <div>
              <h3 id="share-library-members">People</h3>
              <p>People, invitations, roles, and ownership.</p>
            </div>
          </div>
          <LibraryMemberEditor
            libraryId={parseResourceRef(snapshot.subject)?.id ?? ""}
          />
        </section>
      ) : null}

      {snapshot &&
      (mode === "ResourceGrants" || mode === "CopyWithLibraryFiling") ? (
        <ResourceLibraryEntryEditor subject={snapshot.subject} />
      ) : null}

      {actionError ? (
        <div className={styles.error} role="alert">
          {actionError}
        </div>
      ) : null}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
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
}: {
  snapshot: ShareSnapshot;
  onSnapshotChange: (snapshot: ShareSnapshot) => void;
  onCopy: (href: string, label: string) => Promise<void>;
  onNativeShare: (href: string, title: string) => Promise<boolean>;
  announce: (message: string) => void;
  reportError: (error: unknown, fallback: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ShareUserProjection[]>([]);
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
        const next = await searchShareUsers(trimmed, controller.signal);
        if (searchSequence.current === sequence) setResults(next);
      } catch (error) {
        if (!controller.signal.aborted) {
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
  }, [query, reportError]);

  const addUser = async (user: ShareUserProjection) => {
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
          ? `Shared with ${shareUserLabel(result.share.user)}.`
          : `${shareUserLabel(result.share.user)} already has this share.`,
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
              id="share-user-results"
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
          <AvailabilityNote
            availability={snapshot.creationAvailability.user}
          />
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
                          reportError(error, "The shared access could not be declined.");
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
                onClick={() => void onCopy(publicShare.publicHref, "Public link")}
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
                  may retain the credential. Posting also makes an unlisted
                  link effectively published.
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

function ResourceLibraryEntryEditor({ subject }: { subject: string }) {
  const ref = useMemo(() => parseResourceRef(subject), [subject]);
  const media = useLibraryMembership(ref?.scheme === "media" ? ref.id : null);
  const loadMediaLibraries = media.loadLibraries;
  const [podcastLibraries, setPodcastLibraries] = useState<
    LibraryTargetPickerItem[]
  >([]);
  const [podcastLoading, setPodcastLoading] = useState(false);
  const [podcastBusy, setPodcastBusy] = useState(false);
  const [podcastError, setPodcastError] = useState<string | null>(null);

  const loadPodcastLibraries = useCallback(async () => {
    if (ref?.scheme !== "podcast") return;
    setPodcastLoading(true);
    setPodcastError(null);
    try {
      setPodcastLibraries(await fetchPodcastLibraries(ref.id));
    } catch (error) {
      if (handleUnauthenticatedApiError(error)) return;
      setPodcastError(
        toFeedback(error, { fallback: "Libraries could not be loaded." }).title,
      );
    } finally {
      setPodcastLoading(false);
    }
  }, [ref]);

  useEffect(() => {
    if (ref?.scheme === "media") {
      void loadMediaLibraries();
    } else if (ref?.scheme === "podcast") {
      void loadPodcastLibraries();
    }
  }, [loadMediaLibraries, loadPodcastLibraries, ref?.scheme]);

  if (!ref || (ref.scheme !== "media" && ref.scheme !== "podcast")) return null;

  const podcastMutation = async (
    libraryId: string,
    kind: "add" | "remove",
  ) => {
    setPodcastBusy(true);
    setPodcastError(null);
    try {
      if (kind === "add") {
        await addPodcastToLibrary(ref.id, libraryId);
      } else {
        await removePodcastFromLibrary(ref.id, libraryId);
      }
      setPodcastLibraries((current) =>
        current.map((library) =>
          library.id === libraryId
            ? { ...library, isInLibrary: kind === "add" }
            : library,
        ),
      );
    } catch (error) {
      if (handleUnauthenticatedApiError(error)) return;
      setPodcastError(
        toFeedback(error, {
          fallback:
            kind === "add"
              ? "The podcast could not be added."
              : "The podcast could not be removed.",
        }).title,
      );
    } finally {
      setPodcastBusy(false);
    }
  };

  return (
    <section className={styles.section} aria-labelledby="share-libraries">
      <div className={styles.sectionHeading}>
        <div>
          <h3 id="share-libraries">Libraries</h3>
          <p>Choose where this {ref.scheme === "podcast" ? "podcast" : "media"} is filed.</p>
        </div>
      </div>
      <LibraryEntryEditor
        libraries={
          ref.scheme === "media" ? media.libraries : podcastLibraries
        }
        loading={
          ref.scheme === "media" ? media.loading : podcastLoading
        }
        busy={ref.scheme === "media" ? media.busy : podcastBusy}
        error={ref.scheme === "media" ? media.error : podcastError}
        onRetry={
          ref.scheme === "media"
            ? () => void media.loadLibraries()
            : () => void loadPodcastLibraries()
        }
        onAddToLibrary={(libraryId) => {
          if (ref.scheme === "media") {
            void media.addToLibrary(libraryId);
          } else {
            void podcastMutation(libraryId, "add");
          }
        }}
        onRemoveFromLibrary={(libraryId) => {
          if (ref.scheme === "media") {
            void media.removeFromLibrary(libraryId);
          } else {
            void podcastMutation(libraryId, "remove");
          }
        }}
      />
    </section>
  );
}
