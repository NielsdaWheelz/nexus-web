"use client";

import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Dialog from "@/components/ui/Dialog";
import Button from "@/components/ui/Button";
import LibrarySettingsDialog from "@/components/LibrarySettingsDialog";
import AcquisitionControl from "@/components/browse/AcquisitionControl";
import PodcastSubscriptionSettingsModal from "@/app/(authenticated)/podcasts/PodcastSubscriptionSettingsModal";
import type { PodcastSubscriptionSettingsModal as PodcastSubscriptionSettingsModalState } from "@/app/(authenticated)/podcasts/usePodcastSubscriptionSettingsModal";
import { mapMediaAuthorCredits } from "@/app/(authenticated)/media/[id]/mediaFormatting";
import { apiFetch, isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { absent, type Presence } from "@/lib/api/presence";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  useFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import {
  deleteMemberLibrary,
  getMemberLibrary,
  renameMemberLibrary,
} from "@/lib/libraries/client";
import { publishLibraryPlacementChange } from "@/lib/libraries/placementRevision";
import {
  fetchPodcastSubscriptionSettingsSource,
  savePodcastSubscriptionSettings,
} from "@/lib/podcasts/subscriptionSettings";
import type { PauseShorteningMode } from "@/lib/player/pauseShortening";
import { subscribeToPodcast } from "@/lib/podcasts/acquisition";
import { publishResourceActionSnapshotInvalidation } from "@/lib/actions/resourceActionSnapshotInvalidation";
import type { LibraryOut } from "@/lib/libraries/contract";
import type { ContributorCredit, MediaAuthorCredit } from "@/lib/contributors/types";
import { PaneReturnVisitScope } from "@/lib/workspace/paneReturnMemento";
import { createPaneVisitId } from "@/lib/workspace/schema";

// The single app-level owner of the resource overlays the canonical
// resource-action runtime dispatches to (edit-authors, library-settings,
// podcast-settings, subscribe). It mirrors ShareControllerProvider /
// LibraryPlacementControllerProvider: a provider mounted in AuthenticatedShell
// exposes id-keyed openers the runtime (and, until their menus migrate, the
// pane bodies) call, and a matching renderer owns the overlay UI so exactly one
// copy of each overlay exists. Each overlay is self-loading: an opener carries
// only a resource id, so the overlay fetches its own current facts, just as the
// share overlay self-loads its snapshot. Opening is not a mutation, so it holds
// no busy state and triggers no reconcile; an overlay that commits a
// state-changing mutation publishes a snapshot invalidation of its own.

// ---------------------------------------------------------------------------
// Controller context
// ---------------------------------------------------------------------------

export interface ResourceOverlaySession {
  readonly key: number;
  readonly id: string;
}

interface ResourceOverlaysContextValue {
  readonly openAuthorsEditor: (mediaId: string) => void;
  readonly openLibrarySettings: (libraryId: string) => void;
  readonly openPodcastSettings: (podcastId: string) => void;
  readonly openSubscribe: (podcastId: string) => void;
  readonly authors: ResourceOverlaySession | null;
  readonly librarySettings: ResourceOverlaySession | null;
  readonly podcastSettings: ResourceOverlaySession | null;
  readonly subscribe: ResourceOverlaySession | null;
  readonly closeAuthors: () => void;
  readonly closeLibrarySettings: () => void;
  readonly closePodcastSettings: () => void;
  readonly closeSubscribe: () => void;
}

const ResourceOverlaysContext =
  createContext<ResourceOverlaysContextValue | null>(null);

function useResourceOverlaysContext(): ResourceOverlaysContextValue {
  const value = useContext(ResourceOverlaysContext);
  if (!value) {
    throw new Error("ResourceOverlaysProvider is missing");
  }
  return value;
}

/** The id-keyed openers the runtime and pane menus dispatch to. */
export function useResourceOverlaysController(): Pick<
  ResourceOverlaysContextValue,
  | "openAuthorsEditor"
  | "openLibrarySettings"
  | "openPodcastSettings"
  | "openSubscribe"
> {
  const value = useResourceOverlaysContext();
  return useMemo(
    () => ({
      openAuthorsEditor: value.openAuthorsEditor,
      openLibrarySettings: value.openLibrarySettings,
      openPodcastSettings: value.openPodcastSettings,
      openSubscribe: value.openSubscribe,
    }),
    [
      value.openAuthorsEditor,
      value.openLibrarySettings,
      value.openPodcastSettings,
      value.openSubscribe,
    ],
  );
}

function useOverlaySession(): [
  ResourceOverlaySession | null,
  (id: string) => void,
  () => void,
] {
  const [session, setSession] = useState<ResourceOverlaySession | null>(null);
  const nextKeyRef = useRef(0);
  const open = useCallback((id: string) => {
    nextKeyRef.current += 1;
    setSession({ key: nextKeyRef.current, id });
  }, []);
  const close = useCallback(() => setSession(null), []);
  return [session, open, close];
}

export function ResourceOverlaysProvider({ children }: { children: ReactNode }) {
  const [authors, openAuthorsEditor, closeAuthors] = useOverlaySession();
  const [librarySettings, openLibrarySettings, closeLibrarySettings] =
    useOverlaySession();
  const [podcastSettings, openPodcastSettings, closePodcastSettings] =
    useOverlaySession();
  const [subscribe, openSubscribe, closeSubscribe] = useOverlaySession();

  const value = useMemo<ResourceOverlaysContextValue>(
    () => ({
      openAuthorsEditor,
      openLibrarySettings,
      openPodcastSettings,
      openSubscribe,
      authors,
      librarySettings,
      podcastSettings,
      subscribe,
      closeAuthors,
      closeLibrarySettings,
      closePodcastSettings,
      closeSubscribe,
    }),
    [
      openAuthorsEditor,
      openLibrarySettings,
      openPodcastSettings,
      openSubscribe,
      authors,
      librarySettings,
      podcastSettings,
      subscribe,
      closeAuthors,
      closeLibrarySettings,
      closePodcastSettings,
      closeSubscribe,
    ],
  );

  return (
    <ResourceOverlaysContext.Provider value={value}>
      {children}
    </ResourceOverlaysContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Renderer — mounted deep (inside the player runtime + a synthetic pane-visit
// scope) so the overlays it owns can reuse the existing player-coupled and
// pane-visit-coupled controls. Owning them here keeps a single overlay copy.
// ---------------------------------------------------------------------------

function returnFocusToActiveElement(): () => HTMLElement | null {
  const active =
    typeof document !== "undefined" &&
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  return () => active;
}

export function ResourceActionOverlays() {
  const {
    authors,
    librarySettings,
    podcastSettings,
    subscribe,
    closeAuthors,
    closeLibrarySettings,
    closePodcastSettings,
    closeSubscribe,
  } = useResourceOverlaysContext();
  // A stable synthetic pane-visit scope so any pane-visit-coupled control inside
  // the settings overlays has a scope to read. The Subscribe overlay mints its
  // OWN fresh per-session scope (below) because its acquisition control stages
  // library selections that must not leak across sessions.
  const [visitId] = useState(() => createPaneVisitId());

  return (
    <PaneReturnVisitScope visitId={visitId} routeKey="resource-action-overlays">
      {authors ? (
        <AuthorsEditorOverlay
          key={authors.key}
          mediaId={authors.id}
          onClose={closeAuthors}
        />
      ) : null}
      {librarySettings ? (
        <LibrarySettingsOverlay
          key={librarySettings.key}
          libraryId={librarySettings.id}
          onClose={closeLibrarySettings}
        />
      ) : null}
      {podcastSettings ? (
        <PodcastSettingsOverlay
          key={podcastSettings.key}
          podcastId={podcastSettings.id}
          onClose={closePodcastSettings}
        />
      ) : null}
      {subscribe ? (
        <SubscribeOverlay
          key={subscribe.key}
          podcastId={subscribe.id}
          onClose={closeSubscribe}
        />
      ) : null}
    </PaneReturnVisitScope>
  );
}

// ---------------------------------------------------------------------------
// Edit authors
// ---------------------------------------------------------------------------

const MediaAuthorsEditor = lazy(
  () => import("@/components/contributors/MediaAuthorsEditor"),
);

interface MediaAuthorsSource {
  readonly authors: MediaAuthorCredit[];
  readonly authorMode: "automatic" | "manual";
}

async function fetchMediaAuthorsSource(
  mediaId: string,
  signal: AbortSignal,
): Promise<MediaAuthorsSource> {
  const raw = await apiFetch<unknown>(`/api/media/${mediaId}`, { signal });
  if (typeof raw !== "object" || raw === null || !("data" in raw)) {
    throw new TypeError("Media envelope is invalid");
  }
  const data = (raw as { data: unknown }).data;
  if (typeof data !== "object" || data === null) {
    throw new TypeError("Media.data is invalid");
  }
  const record = data as {
    contributors?: readonly ContributorCredit[] | null;
    author_mode?: unknown;
  };
  return {
    authors: mapMediaAuthorCredits(record.contributors),
    authorMode: record.author_mode === "manual" ? "manual" : "automatic",
  };
}

function AuthorsEditorOverlay({
  mediaId,
  onClose,
}: {
  mediaId: string;
  onClose: () => void;
}) {
  const feedback = useFeedback();
  const [source, setSource] = useState<MediaAuthorsSource | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const returnFocusTo = useMemo(returnFocusToActiveElement, []);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        setSource(await fetchMediaAuthorsSource(mediaId, controller.signal));
      } catch (error) {
        if (controller.signal.aborted || handleUnauthenticatedApiError(error)) {
          return;
        }
        if (isApiError(error) && !isSameSystemApiDefect(error)) {
          feedback.publish({
            kind: "Hud",
            content: {
              tone: "Danger",
              title: "Authors couldn’t be loaded",
              requestId: error.requestId,
            },
          });
          onClose();
          return;
        }
        setDefect({ error });
      }
    })();
    return () => controller.abort();
  }, [mediaId, feedback, onClose]);

  if (defect) throw defect.error;
  if (!source) return null;

  return (
    <Suspense fallback={null}>
      <MediaAuthorsEditor
        open
        mediaId={mediaId}
        authors={source.authors}
        authorMode={source.authorMode}
        returnFocusTo={returnFocusTo}
        returnFocusFallback={() => null}
        onClose={onClose}
        onSaved={() => {
          publishResourceActionSnapshotInvalidation();
          onClose();
        }}
      />
    </Suspense>
  );
}

// ---------------------------------------------------------------------------
// Library settings
// ---------------------------------------------------------------------------

function LibrarySettingsOverlay({
  libraryId,
  onClose,
}: {
  libraryId: string;
  onClose: () => void;
}) {
  const feedback = useFeedback();
  const [library, setLibrary] = useState<LibraryOut | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        setLibrary(await getMemberLibrary(libraryId, controller.signal));
      } catch (error) {
        if (controller.signal.aborted || handleUnauthenticatedApiError(error)) {
          return;
        }
        if (isApiError(error) && !isSameSystemApiDefect(error)) {
          feedback.publish({
            kind: "Hud",
            content: {
              tone: "Danger",
              title: "Library settings couldn’t be loaded",
              requestId: error.requestId,
            },
          });
          onClose();
          return;
        }
        setDefect({ error });
      }
    })();
    return () => controller.abort();
  }, [libraryId, feedback, onClose]);

  if (defect) throw defect.error;
  if (!library) return null;

  return (
    <LibrarySettingsDialog
      open
      onClose={onClose}
      library={{
        id: library.id,
        name: library.name,
        canRename: library.canRename,
        canDelete: library.canDelete,
      }}
      onRename={async (name) => {
        await renameMemberLibrary(libraryId, name);
      }}
      onDelete={async () => {
        await deleteMemberLibrary(libraryId);
        publishLibraryPlacementChange("Unknown");
        publishResourceActionSnapshotInvalidation();
        onClose();
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Podcast subscription settings
// ---------------------------------------------------------------------------

function podcastSettingsErrorContent(error: unknown): FeedbackContent {
  const requestId = isApiError(error) ? error.requestId : undefined;
  return {
    tone: "Danger",
    title: "Subscription settings weren’t saved",
    requestId,
  };
}

function usePodcastSettingsOverlayState(
  podcastId: string,
  onSaved: () => void,
): PodcastSubscriptionSettingsModalState & { seed: (open: boolean) => void } {
  const [active, setActive] = useState(false);
  const [defaultPlaybackSpeed, setDefaultPlaybackSpeed] =
    useState<Presence<number>>(absent());
  const [pauseShorteningMode, setPauseShorteningMode] =
    useState<Presence<PauseShorteningMode>>(absent());
  const [autoQueue, setAutoQueue] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FeedbackContent | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const busyRef = useRef(false);
  const seededRef = useRef(false);

  const seed = useCallback(
    (openWith: boolean) => {
      seededRef.current = true;
      setActive(openWith);
    },
    [],
  );

  const close = useCallback(() => {
    if (busyRef.current) return;
    setActive(false);
  }, []);

  const save = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await savePodcastSubscriptionSettings(podcastId, {
        defaultPlaybackSpeed,
        pauseShorteningMode,
        autoQueue,
      });
      onSaved();
      setActive(false);
    } catch (saveError) {
      if (handleUnauthenticatedApiError(saveError)) return;
      if (!isApiError(saveError) || isSameSystemApiDefect(saveError)) {
        setDefect({ error: saveError });
        return;
      }
      setError(podcastSettingsErrorContent(saveError));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [autoQueue, defaultPlaybackSpeed, onSaved, pauseShorteningMode, podcastId]);

  if (defect) throw defect.error;

  return {
    podcastId: active ? podcastId : null,
    defaultPlaybackSpeed,
    pauseShorteningMode,
    autoQueue,
    busy,
    error,
    setDefaultPlaybackSpeed,
    setPauseShorteningMode,
    setAutoQueue,
    // The overlay drives seeding through `seed`; `open` is unused here.
    open: () => {},
    close,
    save,
    seed,
  };
}

function PodcastSettingsOverlay({
  podcastId,
  onClose,
}: {
  podcastId: string;
  onClose: () => void;
}) {
  const feedback = useFeedback();
  const onSaved = useCallback(() => {
    publishResourceActionSnapshotInvalidation();
  }, []);
  const state = usePodcastSettingsOverlayState(podcastId, onSaved);
  const [loaded, setLoaded] = useState(false);
  const seed = state.seed;
  const setDefaultPlaybackSpeed = state.setDefaultPlaybackSpeed;
  const setPauseShorteningMode = state.setPauseShorteningMode;
  const setAutoQueue = state.setAutoQueue;

  // Self-load the current settings, seed them, then reveal the modal.
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const src = await fetchPodcastSubscriptionSettingsSource(
          podcastId,
          controller.signal,
        );
        setDefaultPlaybackSpeed(src.default_playback_speed);
        setPauseShorteningMode(src.pause_shortening_mode);
        setAutoQueue(src.auto_queue);
        seed(true);
        setLoaded(true);
      } catch (error) {
        if (controller.signal.aborted || handleUnauthenticatedApiError(error)) {
          return;
        }
        feedback.publish({
          kind: "Hud",
          content: {
            tone: "Danger",
            title: "Subscription settings couldn’t be loaded",
            requestId: isApiError(error) ? error.requestId : undefined,
          },
        });
        onClose();
      }
    })();
    return () => controller.abort();
  }, [
    podcastId,
    feedback,
    onClose,
    seed,
    setDefaultPlaybackSpeed,
    setPauseShorteningMode,
    setAutoQueue,
  ]);

  // When the modal state closes (Close pressed / saved), tear the overlay down.
  const wasActiveRef = useRef(false);
  useEffect(() => {
    const isActive = state.podcastId !== null;
    if (wasActiveRef.current && !isActive) onClose();
    wasActiveRef.current = isActive;
  }, [state.podcastId, onClose]);

  if (!loaded) return null;

  return (
    <PodcastSubscriptionSettingsModal
      podcastTitle="this podcast"
      settingsModal={state}
    />
  );
}

// ---------------------------------------------------------------------------
// Subscribe (reuses the acquisition flow)
// ---------------------------------------------------------------------------

function SubscribeOverlay({
  podcastId,
  onClose,
}: {
  podcastId: string;
  onClose: () => void;
}) {
  // AcquisitionControl stages its library selection into pane-visit data, so a
  // shared scope would leak the previous Subscribe session's staged selection
  // into the next open. This overlay is keyed by the subscribe session, so a
  // fresh visit id per mount scopes that staged state to one session only.
  const [visitId] = useState(() => createPaneVisitId());
  return (
    <PaneReturnVisitScope visitId={visitId} routeKey="resource-action-subscribe">
      <Dialog open onClose={onClose} title="Subscribe">
        <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          <p>Subscribe to this podcast and choose where to file it.</p>
          <AcquisitionControl
          kind="Subscribe"
          subscribed={false}
          commit={async (command) => {
            const result = await subscribeToPodcast({
              target: { kind: "Canonical", podcastId },
              namedLibraryIds: command.namedLibraryIds,
              replacementConfirmation: command.replacementConfirmation,
              idempotencyKey: command.idempotencyKey,
            });
            return { href: result.href };
          }}
          onCommitted={() => {
            publishResourceActionSnapshotInvalidation();
            onClose();
          }}
        />
          <div>
            <Button variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </div>
      </Dialog>
    </PaneReturnVisitScope>
  );
}
