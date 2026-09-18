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
import PodcastSubscriptionSettingsOverlay from "@/components/podcasts/PodcastSubscriptionSettingsOverlay";
import { mapMediaAuthorCredits } from "@/app/(authenticated)/media/[id]/mediaFormatting";
import { apiFetch, isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isAbortError } from "@/lib/errors";
import { useFeedback } from "@/components/feedback/Feedback";
import {
  deleteMemberLibrary,
  getMemberLibrary,
  renameMemberLibrary,
} from "@/lib/libraries/client";
import { subscribeToPodcast } from "@/lib/podcasts/acquisition";
import type {
  ResourceActionMutationBoundary,
  ResourceActionMutationLease,
} from "@/lib/actions/resourceActionMutation";
import { settleDeletedResourcePanes } from "@/lib/actions/resourceDeletionLifecycle";
import type { LibraryOut } from "@/lib/libraries/contract";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import type {
  ContributorCredit,
  MediaAuthorCredit,
} from "@/lib/contributors/types";
import { PaneReturnVisitScope } from "@/lib/workspace/paneReturnMemento";
import { createPaneVisitId } from "@/lib/workspace/schema";
import { useWorkspaceStore } from "@/lib/workspace/store";

// The single app-level owner of the resource overlays the canonical
// resource-action runtime dispatches to (edit-authors, library-settings,
// podcast-settings, subscribe). It mirrors ShareControllerProvider /
// LibraryPlacementControllerProvider: a provider mounted in AuthenticatedShell
// exposes id-keyed openers the runtime calls, and a matching renderer owns the
// overlay UI so exactly one copy of each overlay exists. Each overlay is
// self-loading: an opener carries
// only a resource id, so the overlay fetches its own current facts, just as the
// share overlay self-loads its snapshot. Opening is not a mutation, so it holds
// no busy state and triggers no reconcile; an overlay that commits a
// state-changing mutation awaits the runtime-supplied typed reconciliation port.

// ---------------------------------------------------------------------------
// Controller context
// ---------------------------------------------------------------------------

interface ResourceOverlaySession {
  readonly key: number;
  readonly id: string;
  readonly mutation: ResourceActionMutationBoundary;
}

type OpenResourceOverlay = (
  id: string,
  mutation: ResourceActionMutationBoundary,
) => void;

interface ResourceOverlaysContextValue {
  readonly openAuthorsEditor: OpenResourceOverlay;
  readonly openLibrarySettings: OpenResourceOverlay;
  readonly openPodcastSettings: OpenResourceOverlay;
  readonly openSubscribe: OpenResourceOverlay;
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
  OpenResourceOverlay,
  () => void,
] {
  const [session, setSession] = useState<ResourceOverlaySession | null>(null);
  const sessionRef = useRef<ResourceOverlaySession | null>(null);
  const nextKeyRef = useRef(0);
  const open = useCallback<OpenResourceOverlay>(
    (id, mutation) => {
      // Preserve the visible editor and its draft. In particular, no later menu
      // invocation may unmount an in-flight mutation owner.
      if (sessionRef.current !== null) return;
      nextKeyRef.current += 1;
      const next = { key: nextKeyRef.current, id, mutation };
      sessionRef.current = next;
      setSession(next);
    },
    [],
  );
  const close = useCallback(() => {
    const current = sessionRef.current;
    if (current?.mutation.isActive()) return;
    sessionRef.current = null;
    setSession(null);
  }, []);
  return [session, open, close];
}

export function ResourceOverlaysProvider({
  children,
}: {
  children: ReactNode;
}) {
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
          mutation={authors.mutation}
          onClose={closeAuthors}
        />
      ) : null}
      {librarySettings ? (
        <LibrarySettingsOverlay
          key={librarySettings.key}
          libraryId={librarySettings.id}
          mutation={librarySettings.mutation}
          onClose={closeLibrarySettings}
        />
      ) : null}
      {podcastSettings ? (
        <PodcastSubscriptionSettingsOverlay
          key={podcastSettings.key}
          podcastId={podcastSettings.id}
          mutation={podcastSettings.mutation}
          onClose={closePodcastSettings}
        />
      ) : null}
      {subscribe ? (
        <SubscribeOverlay
          key={subscribe.key}
          podcastId={subscribe.id}
          mutation={subscribe.mutation}
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
  mutation,
  onClose,
}: {
  mediaId: string;
  mutation: ResourceActionMutationBoundary;
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
        mutation={mutation}
        onSaved={async (_next, lease) => {
          await lease.reconcile({
            kind: "Subjects",
            refs: [assumeCanonicalResourceRef(`media:${mediaId}`)],
          });
          await lease.commit();
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
  mutation,
  onClose,
}: {
  libraryId: string;
  mutation: ResourceActionMutationBoundary;
  onClose: () => void;
}) {
  const feedback = useFeedback();
  const workspace = useWorkspaceStore();
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
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
        const lease = mutation.begin();
        if (lease === null) return;
        try {
          await renameMemberLibrary(libraryId, name);
          await lease.reconcile({
            kind: "Subjects",
            refs: [assumeCanonicalResourceRef(`library:${libraryId}`)],
          });
          await lease.commit();
          setLibrary((current) =>
            current === null ? current : { ...current, name },
          );
        } catch (error) {
          lease.abort();
          if (handleUnauthenticatedApiError(error)) return;
          if (isApiError(error) && !isSameSystemApiDefect(error)) {
            feedback.publish({
              kind: "Hud",
              content: {
                tone: "Danger",
                title: "Library name wasn’t saved",
                requestId: error.requestId,
              },
            });
            return;
          }
          setDefect({ error });
        }
      }}
      onDelete={async () => {
        const lease = mutation.begin();
        if (lease === null) return;
        const libraryRef = assumeCanonicalResourceRef(`library:${libraryId}`);
        try {
          await deleteMemberLibrary(libraryId);
          settleDeletedResourcePanes({
            workspace: workspaceRef.current,
            deletedRef: libraryRef,
            fallbackHref: "/libraries",
          });
          await lease.reconcile({ kind: "AllRetained" });
          await lease.commit();
          onClose();
        } catch (error) {
          lease.abort();
          if (handleUnauthenticatedApiError(error)) return;
          if (isApiError(error) && !isSameSystemApiDefect(error)) {
            feedback.publish({
              kind: "Hud",
              content: {
                tone: "Danger",
                title: "Library couldn’t be deleted",
                requestId: error.requestId,
              },
            });
            return;
          }
          setDefect({ error });
        }
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Subscribe (reuses the acquisition flow)
// ---------------------------------------------------------------------------

function SubscribeOverlay({
  podcastId,
  mutation,
  onClose,
}: {
  podcastId: string;
  mutation: ResourceActionMutationBoundary;
  onClose: () => void;
}) {
  // AcquisitionControl stages its library selection into pane-visit data, so a
  // shared scope would leak the previous Subscribe session's staged selection
  // into the next open. This overlay is keyed by the subscribe session, so a
  // fresh visit id per mount scopes that staged state to one session only.
  const [visitId] = useState(() => createPaneVisitId());
  const leaseRef = useRef<ResourceActionMutationLease | null>(null);
  return (
    <PaneReturnVisitScope
      visitId={visitId}
      routeKey="resource-action-subscribe"
    >
      <Dialog open onClose={onClose} title="Subscribe">
        <div
          style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
        >
          <p>Subscribe to this podcast and choose where to file it.</p>
          <AcquisitionControl
            kind="Subscribe"
            subscribed={false}
            commit={async (command) => {
              const lease = leaseRef.current ?? mutation.begin();
              if (lease === null) {
                // justify-defect: this sole overlay owns the unsubscribed
                // podcast command, and AcquisitionControl serializes its run.
                throw new Error("Podcast subscription action is already busy");
              }
              leaseRef.current = lease;
              try {
                const result = await subscribeToPodcast({
                  target: { kind: "Canonical", podcastId },
                  namedLibraryIds: command.namedLibraryIds,
                  replacementConfirmation: command.replacementConfirmation,
                  idempotencyKey: command.idempotencyKey,
                });
                return { href: result.href };
              } catch (error) {
                const settlementUnknown =
                  isAbortError(error) ||
                  (isApiError(error) && error.code === "E_NETWORK");
                if (!settlementUnknown) {
                  lease.abort();
                  leaseRef.current = null;
                }
                throw error;
              }
            }}
            onCommitted={async () => {
              const lease = leaseRef.current;
              if (lease === null) {
                // justify-defect: AcquisitionControl calls onCommitted only
                // after the wrapped domain command returned successfully.
                throw new Error(
                  "Podcast subscription mutation lease is missing",
                );
              }
              try {
                await lease.reconcile({ kind: "AllRetained" });
                await lease.commit();
                leaseRef.current = null;
                onClose();
              } catch (error) {
                lease.abort();
                leaseRef.current = null;
                throw error;
              }
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
