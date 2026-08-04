"use client";

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { Plus } from "lucide-react";
import { requestNexusOpen } from "@/lib/nexus/events";
import {
  ApiError,
  apiFetch,
  isApiError,
} from "@/lib/api/client";
import { present, type Presence } from "@/lib/api/presence";
import {
  decodeCollectionPage,
  type CollectionCursor,
  type CollectionPage,
  type CollectionRevision,
} from "@/lib/api/collectionPage";
import { useExhaustivePagination } from "@/lib/api/useExhaustivePagination";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  libraryEntriesResource,
  libraryResource as libraryResourceDescriptor,
  type LibraryEntriesResourceParams,
} from "@/lib/api/resource";
import { runSourceProcessingAction } from "@/lib/media/sourceActions";
import { retryMediaMetadata } from "@/lib/media/ingestionClient";
import {
  FeedbackNotice,
  type FeedbackAnnouncement,
  type FeedbackActions,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import ConnectionsSurface from "@/components/connections/ConnectionsSurface";
import { useConnectionsComposerController } from "@/components/connections/connectionsComposerController";
import {
  RESOURCE_ACTION_CATALOG,
  type ResourceActionId,
} from "@/lib/actions/resourceActions";
import { useLectern } from "@/lib/lectern/LecternProvider";
import { useCompletionUndo } from "@/lib/lectern/useCompletionUndo";
import {
  parseMediaId,
  type ConsumptionResult,
  type LecternItemId,
} from "@/lib/lectern/contract";
import { runProgressReset } from "@/lib/consumption/progressReset";
import { presentMedia } from "@/lib/collections/presenters/media";
import { presentPodcast } from "@/lib/collections/presenters/podcast";
import { confirmAndDeleteMedia } from "@/lib/media/mediaLibraries";
import {
  addLibraryPlacement,
  listLibraryPlacements,
} from "@/lib/libraries/libraryPlacement";
import { useStringIdSet, type StringIdSet } from "@/lib/useStringIdSet";
import { clientResourceFetcher } from "@/lib/api/resourceTransport.client";
import { useResource } from "@/lib/api/useResource";
import {
  paneResourceLoaders,
  type LibraryPaneSeed,
} from "@/lib/panes/paneResourceLoaders";
import {
  buildPodcastUnsubscribeConfirmation,
  unsubscribeFromPodcast,
} from "@/app/(authenticated)/podcasts/podcastSubscriptions";
import type { PodcastSubscriptionSettingsResponse } from "@/lib/podcasts/subscriptionSettings";
import { usePodcastSubscriptionSettingsModal } from "@/app/(authenticated)/podcasts/usePodcastSubscriptionSettingsModal";
import { useResourceOverlaysController } from "@/lib/resources/resourceOverlaysController";
import Button from "@/components/ui/Button";
import Select from "@/components/ui/Select";
import Toggle from "@/components/ui/Toggle";
import PaneSurface from "@/components/ui/PaneSurface";
import SectionOpener from "@/components/ui/SectionOpener";
import CollectionView from "@/components/collections/CollectionView";
import CollectionExhaustionNotice from "@/components/collections/CollectionExhaustionNotice";
import ReadingSlateSection from "@/components/collections/ReadingSlateSection";
import type {
  CollectionContext,
  CollectionRowView,
} from "@/lib/collections/types";
import { useDebouncedFetch } from "@/lib/api/useDebouncedFetch";
import LibraryMembersSurface from "@/components/libraries/LibraryMembersSurface";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import { useResourceInspector } from "@/lib/dossiers/useResourceInspector";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import {
  definePaneVisitDataKey,
  useClearAllPaneVisitData,
  usePaneParam,
  usePaneIsActive,
  usePaneReturnReady,
  usePaneRouter,
  usePaneRuntime,
  requirePaneRuntime,
  usePaneVisitData,
  useSetPaneLabel,
} from "@/lib/panes/paneRuntime";
import type { LibraryOut } from "@/lib/libraries/contract";
import { useLibraryMembers } from "@/lib/libraries/useLibraryMembers";
import {
  libraryRequestErrorMessage,
  type LibraryRequest,
} from "@/lib/libraries/libraryRequestErrorMessage";
import { usePaneUrlState } from "@/lib/api/usePaneUrlState";
import {
  CANONICAL_LIBRARY_VIEW,
  LIBRARY_ENTRY_TYPE_OPTION_IDS,
  activeLibraryDomainControlCount,
  completionOf,
  decodeLibraryView,
  encodeLibraryView,
  entryTypeOptionLabel,
  entryTypeOptionOf,
  formatLibraryView,
  isInitialLibraryView,
  orderPresetIdsFor,
  orderToPresetId,
  presetIdToOrder,
  presetLabel,
  projectionOptionLabel,
  projectionOptionOf,
  projectionOptionsFor,
  projectionSupportsCompletion,
  withCompletion,
  withEntryTypeOption,
  withProjectionOption,
  type DecodedLibraryView,
  type LibraryEntryTypeOptionId,
  type LibraryEntryView,
  type LibraryOrderPresetId,
  type ProjectionOptionId,
} from "@/lib/libraries/libraryView";
import { libraryPresentation } from "@/lib/libraries/presentation";
import {
  libraryPlacementSnapshot,
  libraryPlacementAffectedSince,
  useLibraryPlacementRevision,
} from "@/lib/libraries/placementRevision";
import {
  consumptionProjectionSnapshot,
  useConsumptionProjectionRevision,
} from "@/lib/consumption/projectionRevision";
import type { ContributorCredit, MediaAuthors } from "@/lib/contributors/types";
import { matchesPaneFilterQuery } from "@/lib/panes/paneRowFilter";
import usePaneFilterRows from "@/lib/panes/usePaneFilterRows";
import type {
  ActionDescriptor,
  ActionSelectDetail,
} from "@/lib/ui/actionDescriptor";
import type { PaneRefreshPublication } from "@/lib/panes/panePublications";
import { routeResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import { isAbortError } from "@/lib/errors";
import { runPodcastRefresh } from "@/lib/podcasts/refresh";
import { mapMediaAuthorCredits } from "@/app/(authenticated)/media/[id]/mediaFormatting";
import {
  decodeLibraryEntryListItem,
  type LibraryEntryListItem,
  type LibraryMediaListItem,
  type LibraryMediaListValue,
  type LibraryPodcastListItem,
} from "@/lib/libraries/entryListItem";
import { slateTargetId } from "@/lib/resonance/contract";
import type { ReadingSlateAccept } from "@/lib/resonance/useReadingSlate";
import { findPaneSearchFocusTarget } from "@/lib/workspace/paneDom";
import styles from "./LibraryPaneBody.module.css";

const MediaAuthorsEditor = lazy(
  () =>
    import(/* @vite-ignore */ "@/components/contributors/MediaAuthorsEditor"),
);

type Library = LibraryOut;

type LibraryMediaEntry = LibraryMediaListValue;

type LibraryMediaConsumption = Pick<
  LibraryMediaEntry,
  "read_state" | "progress_fraction"
>;

type LibraryEntry = LibraryEntryListItem;
type LibraryEntryPage = CollectionPage<LibraryEntry>;

// The two process-local fact revisions the pane binds every entry request to.
// A committed page records the revisions it was fetched at; a later advance
// (that this pane reacts to) drives one reconciliation of the current view.
interface LibraryRevisions {
  placement: number;
  consumption: number;
}

interface EntryReconciliationRequest {
  ownerId: string;
  view: LibraryEntryView;
  serial: number;
  recovery: "Retry" | "RefreshList";
  // The revisions captured when this reconciliation was requested. On commit
  // they become the committed baseline, so a mutation that landed while the
  // reconciliation was in flight surfaces as exactly one coalesced follow-up.
  revisions: LibraryRevisions;
}

interface EntryReconciliationResult {
  request: EntryReconciliationRequest;
  page: LibraryEntryPage;
}

interface PendingLibraryRevalidation {
  readonly serial: number;
  readonly sourceKey: string;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly removeAbortListener: () => void;
}

type EntryMutationEffect = "SafePatch" | "SafeRebase" | "Unknown";

interface LibraryEntryPageResult {
  requestKey: string;
  requestedViewKey: string;
  view: LibraryEntryView;
  page: LibraryEntryPage;
  revisions: LibraryRevisions;
}

function decodeLibraryEntryPage(page: unknown): LibraryEntryPage {
  return decodeCollectionPage(page, decodeLibraryEntryListItem);
}

type LibraryPaneResource = LibraryPaneSeed;

interface CommittedLibraryView {
  readonly view: LibraryEntryView;
  readonly entries: readonly LibraryEntry[];
  readonly collectionRevision: CollectionRevision;
  readonly nextCursor: Presence<CollectionCursor>;
  readonly exhaustion: "Partial" | "Complete";
  // The fact revisions this committed page was fetched at; a later reacted-to
  // advance reconciles the current view against fresh authoritative truth.
  readonly revisions: LibraryRevisions;
}

interface LibrarySnapshot {
  readonly library: Library;
  readonly entries: CommittedLibraryView;
}

type LibraryEntriesState =
  | {
      kind: "InitialLoading";
      requestedView: LibraryEntryView;
    }
  | {
      kind: "Ready";
      committed: CommittedLibraryView;
    }
  | {
      kind: "Refreshing";
      requestedView: LibraryEntryView;
      committed: CommittedLibraryView;
    }
  | {
      kind: "RefreshFailed";
      requestedView: LibraryEntryView;
      committed: CommittedLibraryView;
      error: ApiError;
    };

const LIBRARY_VISIT_DATA =
  definePaneVisitDataKey<LibrarySnapshot>("Library.Entries");
const EMPTY_LIBRARY_ENTRIES: LibraryEntry[] = [];
const NO_COLLECTION_CURSOR: Presence<CollectionCursor> = { kind: "Absent" };
const ZERO_COLLECTION_REVISION = 0 as CollectionRevision;

function libraryTargetId(entry: LibraryEntry): string {
  return entry.kind === "media" ? entry.media.id : entry.podcast.id;
}

function libraryRowKey(
  entry: LibraryEntry,
  _isDefaultLibrary: boolean,
): string {
  return libraryTargetId(entry);
}

function appendUniqueEntries(
  current: LibraryEntry[],
  next: readonly LibraryEntry[],
  keyOf: (entry: LibraryEntry) => string = libraryTargetId,
): LibraryEntry[] {
  const seen = new Set(current.map(keyOf));
  const merged = [...current];
  for (const entry of next) {
    const key = keyOf(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return merged;
}

interface LibraryPaneFeedback {
  readonly content: FeedbackContent;
  readonly actions?: FeedbackActions;
  readonly announcement?: FeedbackAnnouncement;
}

// The one full-date formatter for the "Added …" row line; the whole instant is
// formatted (not a date-only weekday folio), so it reads unambiguously.
const ADDED_DATE_FORMAT: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
};

function formatAdded(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, ADDED_DATE_FORMAT).format(date);
}

function libraryEntryFilterFields(entry: LibraryEntry): readonly string[] {
  const item = entry.kind === "media" ? entry.media : entry.podcast;
  return [
    item.title,
    ...item.contributors.flatMap((credit) => [
      credit.contributor_display_name ?? "",
      credit.credited_name,
    ]),
  ];
}

// A view whose row membership depends on canonical consumption facts: In
// Progress (only InProgress rows) or any Unfinished completion (Finished rows
// drop out). An unfiltered All-items view is consumption-insensitive, so a bare
// heartbeat never refetches it — the immediate local media patch suffices.
function viewIsConsumptionSensitive(view: LibraryEntryView): boolean {
  return (
    view.projection.kind === "InProgress" || completionOf(view) === "unfinished"
  );
}

// The one code that turns an entry fetch error into the "Invalid library view"
// terminal state: the backend rejects a bad request/cursor with these codes.
function isInvalidViewError(error: unknown): boolean {
  return (
    isApiError(error) &&
    (error.code === "E_INVALID_REQUEST" || error.code === "E_INVALID_CURSOR")
  );
}

export default function LibraryPaneBody() {
  const id = usePaneParam("id");
  if (!id) {
    throw new Error("library route requires an id");
  }
  const router = usePaneRouter();
  const paneRuntime = usePaneRuntime();
  const activateTarget = requirePaneRuntime(
    paneRuntime,
    "LibraryPaneBody",
  ).activateTarget;
  const isPaneActive = usePaneIsActive();
  const paneId = paneRuntime?.paneId ?? `library-${id}`;
  const lectern = useLectern();
  const offerCompletionUndo = useCompletionUndo();

  // The two process-local fact revisions. A placement advance can change which
  // media are filed (and whether Unfiled qualifies); a consumption advance can
  // change which media are InProgress/Unfinished. The revision values never
  // enter an API query — they are the pane's local request identity and the
  // trigger for reconciling the current view against fresh authoritative truth.
  const placementChange = useLibraryPlacementRevision();
  const consumptionChange = useConsumptionProjectionRevision();
  const placementRevisionRef = useRef(placementChange.revision);
  placementRevisionRef.current = placementChange.revision;
  const consumptionRevisionRef = useRef(consumptionChange.revision);
  consumptionRevisionRef.current = consumptionChange.revision;

  // The pane URL owns the library view (order + completion) via a strict, total
  // codec; `decodedView` is a discriminated result and `view` is null only when
  // the URL is Invalid, which is a terminal, user-recoverable state.
  const libraryViewCodec = useMemo(
    () => ({
      basePath: `/libraries/${id}`,
      decode: (params: URLSearchParams): DecodedLibraryView =>
        decodeLibraryView(params),
      encode: (
        decoded: DecodedLibraryView,
        current: URLSearchParams,
      ): URLSearchParams => {
        if (decoded.kind === "Valid") {
          return encodeLibraryView(decoded.view, current);
        }
        const next = new URLSearchParams(current);
        next.delete("sort");
        next.delete("direction");
        next.delete("completion");
        next.delete("projection");
        next.delete("entry_type");
        next.delete("kind");
        next.delete("type");
        next.delete("types");
        return next;
      },
    }),
    [id],
  );
  const { state: decodedView, setState: setDecodedView } =
    usePaneUrlState(libraryViewCodec);
  const view = decodedView.kind === "Valid" ? decodedView.view : null;
  const isInitialView = view !== null && isInitialLibraryView(view);
  const committedViewInvalidatedRef = useRef(false);
  const committedSnapshotRef = useRef<LibrarySnapshot | null>(null);
  const pendingScrollTopRef = useRef<number | null>(null);
  const reorderGenerationRef = useRef(0);
  const capturePaneScroll = useCallback(() => {
    const region = document.getElementById(`library-entry-region-${id}`);
    const scrollport = region?.closest<HTMLElement>("[data-pane-content]");
    if (scrollport) {
      pendingScrollTopRef.current = scrollport.scrollTop;
    }
  }, [id]);
  const setView = useCallback(
    (next: LibraryEntryView) => {
      capturePaneScroll();
      committedViewInvalidatedRef.current = true;
      committedSnapshotRef.current = null;
      reorderGenerationRef.current += 1;
      setDecodedView({ kind: "Valid", view: next });
    },
    [capturePaneScroll, setDecodedView],
  );

  const captureCommitted = useCallback(() => committedSnapshotRef.current, []);
  const restored = usePaneVisitData(LIBRARY_VISIT_DATA, captureCommitted);
  const initialRestored = useRef(restored).current;
  const [controller, setController] = useState<LibrarySnapshot | null>(
    initialRestored,
  );
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  const pendingMutationEffectRef = useRef<EntryMutationEffect | null>(null);
  const reconcileAfterMutationRef = useRef<
    (effect: EntryMutationEffect) => void
  >(() => undefined);
  if (
    committedSnapshotRef.current === null &&
    initialRestored !== null &&
    controller === initialRestored
  ) {
    committedSnapshotRef.current = initialRestored;
  }
  const [observedUnavailableLibraryId, setObservedUnavailableLibraryId] =
    useState<string | null>(null);
  const observedLibraryUnavailable = observedUnavailableLibraryId === id;
  const clearAllVisitData = useClearAllPaneVisitData();
  const allowInitialAdoptionRef = useRef(initialRestored === null);
  const entries = useMemo(
    () =>
      controller === null
        ? EMPTY_LIBRARY_ENTRIES
        : [...controller.entries.entries],
    [controller],
  );
  const entryCursor = controller?.entries.nextCursor ?? NO_COLLECTION_CURSOR;
  const setLibrary: Dispatch<SetStateAction<Library | null>> = useCallback(
    (update) => {
      setController((current) => {
        if (current === null) return current;
        const library =
          typeof update === "function" ? update(current.library) : update;
        return library === null ? null : { ...current, library };
      });
    },
    [],
  );
  const setEntries: Dispatch<SetStateAction<LibraryEntry[]>> = useCallback(
    (update) => {
      setController((current) => {
        if (current === null) return current;
        const previous = [...current.entries.entries];
        const entries =
          typeof update === "function" ? update(previous) : update;
        return {
          ...current,
          entries: { ...current.entries, entries },
        };
      });
    },
    [],
  );
  const [chainEpoch, setChainEpoch] = useState(0);
  const installEntryCollectionRevision = useCallback(
    (collectionRevision: CollectionRevision) => {
      setController((current) => {
        if (current === null) {
          throw new Error(
            "Library entry mutation settled without a committed list",
          );
        }
        const next: LibrarySnapshot = {
          ...current,
          entries: {
            ...current.entries,
            collectionRevision,
          },
        };
        controllerRef.current = next;
        committedSnapshotRef.current = next;
        return next;
      });
      clearAllVisitData();
      setChainEpoch((epoch) => epoch + 1);
    },
    [clearAllVisitData],
  );
  // Set when an entry fetch for the current view is rejected as invalid; cleared
  // whenever the view changes. Renders the terminal "Invalid library view" state.
  const [viewInvalid, setViewInvalid] = useState(false);
  const removedEntryIds = useStringIdSet();
  const retryingMediaIds = useStringIdSet();
  const refreshingMediaIds = useStringIdSet();
  const retryingMetadataMediaIds = useStringIdSet();
  const deletingMediaIds = useStringIdSet();
  const updatingConsumptionMediaIds = useStringIdSet();
  const resettingProgressMediaIds = useStringIdSet();
  const addingToLecternMediaIds = useStringIdSet();
  const removingFromLecternMediaIds = useStringIdSet();
  const refreshingPodcastIds = useStringIdSet();
  const podcastRowRefreshControllersRef = useRef(new Set<AbortController>());
  const unsubscribingPodcastIds = useStringIdSet();
  const [error, setError] = useState<LibraryPaneFeedback | null>(null);
  const [authorityFeedback, setAuthorityFeedback] =
    useState<FeedbackContent | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const presentFailure = useCallback(
    (
      requestError: unknown,
      title: string,
      request: LibraryRequest,
      retry?: { readonly label: string; readonly onClick: () => void },
    ): void => {
      try {
        setError({
          content: libraryRequestErrorMessage(requestError, { title, request }),
          actions: retry ? [{ label: retry.label, onClick: retry.onClick }] : undefined,
        });
      } catch (caughtDefect) {
        setDefect({ error: caughtDefect });
      }
    },
    [],
  );
  const [reorderBusy, setReorderBusy] = useState(false);
  // The revisions the committed page was fetched at. A reacted-to advance beyond
  // this baseline drives one reconciliation of the current view. When the pane is
  // seeded from a restored visit snapshot, the baseline is the snapshot's captured
  // revisions — NOT the current stores — so a mutation between capture and remount
  // reads as stale and reconciles, instead of being silently absorbed.
  const committedRevisionsRef = useRef<LibraryRevisions>(
    initialRestored
      ? initialRestored.entries.revisions
      : {
          placement: placementChange.revision,
          consumption: consumptionChange.revision,
        },
  );
  // Bumped when a first-page result is revision-stale so the exact same
  // requested view refetches once against current truth (coalesced follow-up).
  const [firstPageNonce, setFirstPageNonce] = useState(0);
  const entryReconciliationSerialRef = useRef(0);
  const pendingLibraryRevalidationRef =
    useRef<PendingLibraryRevalidation | null>(null);
  const completedLibraryRevalidationSerialRef = useRef<number | null>(null);
  const [entryReconciliationRequest, setEntryReconciliationRequest] =
    useState<EntryReconciliationRequest | null>(null);
  const entryReconciliationRequestRef = useRef(entryReconciliationRequest);
  entryReconciliationRequestRef.current = entryReconciliationRequest;
  const consumptionOperationTokensRef = useRef(new Map<string, symbol>());
  const handlePodcastSettingsSaved = useCallback(
    (response: PodcastSubscriptionSettingsResponse) => {
      setEntries((current) =>
        current.map((candidate) =>
          candidate.kind === "podcast" &&
          candidate.podcast.id === response.podcast_id &&
          candidate.subscription !== null
            ? {
                ...candidate,
                subscription: {
                  ...candidate.subscription,
                  default_playback_speed: response.default_playback_speed,
                  pause_shortening_mode: response.pause_shortening_mode,
                  auto_queue: response.auto_queue,
                },
              }
            : candidate,
        ),
      );
      installEntryCollectionRevision(response.libraryEntriesCollectionRevision);
      reconcileAfterMutationRef.current("SafeRebase");
    },
    [installEntryCollectionRevision, setEntries],
  );
  const resourceOverlays = useResourceOverlaysController();
  // The settings overlay is owned app-level (ResourceActionOverlays); this hook
  // is kept only for its install subscription, which keeps the pane's list rows
  // current after an app-level settings save.
  usePodcastSubscriptionSettingsModal({ onSaved: handlePodcastSettingsSaved });
  const [authorsEditorMounted, setAuthorsEditorMounted] = useState(false);
  const [authorsEditorOpen, setAuthorsEditorOpen] = useState(false);
  const [authorsEditorMediaId, setAuthorsEditorMediaId] = useState<
    string | null
  >(null);
  const [authorsEditorRowKey, setAuthorsEditorRowKey] = useState<string | null>(
    null,
  );
  const [authorsEditorTrigger, setAuthorsEditorTrigger] =
    useState<HTMLButtonElement | null>(null);
  const authorsEditorMedia =
    entries.find(
      (entry): entry is LibraryMediaListItem =>
        entry.kind === "media" && entry.media.id === authorsEditorMediaId,
    )?.media ?? null;
  const openAuthorsEditor = useCallback(
    (mediaId: string, rowKey: string, { triggerEl }: ActionSelectDetail) => {
      setAuthorsEditorMediaId(mediaId);
      setAuthorsEditorRowKey(rowKey);
      setAuthorsEditorTrigger(triggerEl);
      setAuthorsEditorMounted(true);
      setAuthorsEditorOpen(true);
    },
    [],
  );
  // Focus continuity: when an action removes the focused row, move focus to the
  // next filtered row, else the previous, else the canonical Pane Search target.
  const listRegionRef = useRef<HTMLDivElement | null>(null);
  const typeSelectRef = useRef<HTMLSelectElement | null>(null);
  const viewSelectRef = useRef<HTMLSelectElement | null>(null);
  const sortSelectRef = useRef<HTMLSelectElement | null>(null);
  const hideFinishedInputId = `library-hide-finished-${id}`;
  // A control to focus once the view/reconciliation it initiated commits. A
  // recovery action (Show all items, Clear filters, Show finished, Retry,
  // Refresh list) sets it; the matching commit applies and clears it.
  const pendingCommitFocusRef = useRef<
    "Type" | "View" | "Sort" | "HideFinished" | null
  >(null);
  const focusPendingControl = useCallback(() => {
    const target = pendingCommitFocusRef.current;
    if (target === null) return;
    pendingCommitFocusRef.current = null;
    const element = (() => {
      switch (target) {
        case "Type":
          return typeSelectRef.current;
        case "View":
          return viewSelectRef.current;
        case "Sort":
          return sortSelectRef.current;
        case "HideFinished":
          return document.getElementById(hideFinishedInputId);
      }
    })();
    if (element instanceof HTMLElement) {
      requestAnimationFrame(() => element.focus());
    }
  }, [hideFinishedInputId]);
  const pendingFocusNeighborRef = useRef<string | null | undefined>(undefined);
  const pendingFocusRafRef = useRef(0);
  const filterQueryRef = useRef("");
  const clearPendingFocusNeighbor = useCallback(() => {
    pendingFocusNeighborRef.current = undefined;
  }, []);
  const captureFocusNeighbor = useCallback((removedKey: string) => {
    const region = listRegionRef.current;
    if (!region) {
      pendingFocusNeighborRef.current = null;
      return;
    }
    const rows = Array.from(
      region.querySelectorAll<HTMLElement>("[data-collection-row-id]"),
    );
    const index = rows.findIndex(
      (el) => el.dataset.collectionRowId === removedKey,
    );
    if (index === -1) {
      pendingFocusNeighborRef.current = undefined;
      return;
    }
    const neighbor = rows[index + 1] ?? rows[index - 1] ?? null;
    pendingFocusNeighborRef.current = neighbor?.dataset.collectionRowId ?? null;
  }, []);

  const patchMediaInViews = useCallback(
    (
      mediaId: string,
      patch: (media: LibraryMediaEntry) => LibraryMediaEntry,
    ) => {
      setEntries((current) =>
        current.map((entry) =>
          entry.kind === "media" && entry.media.id === mediaId
            ? { ...entry, media: patch(entry.media) }
            : entry,
        ),
      );
    },
    [setEntries],
  );
  const handleAuthorsSaved = useCallback(
    (result: MediaAuthors) => {
      if (authorsEditorMediaId === null) return;
        const authorCredits: ContributorCredit[] = result.authors.map(
          (author, index) => ({
            contributor_handle: author.contributorHandle,
            contributor_display_name: author.displayName,
            credited_name: author.creditedName,
            role: "author",
            href: author.href,
            ordinal: index,
          }),
        );
      const contributors = [
        ...authorCredits,
        ...(authorsEditorMedia?.contributors.filter(
          (credit) => credit.role !== "author",
        ) ?? []),
      ];
      if (
        authorsEditorMedia !== null &&
        authorsEditorRowKey !== null &&
        filterQueryRef.current.trim() &&
        !matchesPaneFilterQuery(filterQueryRef.current, [
          authorsEditorMedia.title,
          ...contributors.flatMap((credit) => [
            credit.contributor_display_name ?? "",
            credit.credited_name,
          ]),
        ])
      ) {
        captureFocusNeighbor(authorsEditorRowKey);
      }
      patchMediaInViews(authorsEditorMediaId, (media) => {
        return {
          ...media,
          contributors,
          author_mode: result.authorMode,
        };
      });
      setAuthorsEditorOpen(false);
      clearAllVisitData();
      reconcileAfterMutationRef.current("Unknown");
    },
    [
      authorsEditorMediaId,
      authorsEditorMedia,
      authorsEditorRowKey,
      captureFocusNeighbor,
      clearAllVisitData,
      patchMediaInViews,
    ],
  );
  const libraryResource = useResource<LibraryPaneResource, { id: string }>({
    descriptor: libraryResourceDescriptor,
    params: initialRestored === null ? { id } : null,
    load: (params, signal) =>
      paneResourceLoaders.library!.load(
        clientResourceFetcher(signal),
        params,
      ) as Promise<LibraryPaneResource>,
  });
  const requestedViewKey =
    view === null ? null : libraryEntriesResource.cacheKey({ id, view });
  const committedViewKey =
    controller === null
      ? null
      : libraryEntriesResource.cacheKey({ id, view: controller.entries.view });
  const committedMatchesRequested =
    requestedViewKey !== null && requestedViewKey === committedViewKey;
  const committedView = controller?.entries.view ?? null;
  const currentLibrary =
    controller?.library.id === id ? controller.library : null;
  // The Library metadata can be known from the route resource before any entry
  // page commits (a factual/projection deep link, or a non-zero-revision mount
  // that cannot claim the bootstrap seed). In that state the pane still renders
  // its toolbar and the polite status node; only a total absence of metadata
  // keeps the pane-level spinner.
  const knownLibrary =
    currentLibrary ??
    (!observedLibraryUnavailable &&
    libraryResource.status === "ready" &&
    libraryResource.data.library.id === id
      ? libraryResource.data.library
      : null);
  const adoptLibrary = useCallback(
    (next: LibraryOut | null) => {
      setObservedUnavailableLibraryId(next === null ? id : null);
      setLibrary((current) =>
        next === null
          ? null
          : current?.id === next.id || next.id === id
            ? next
            : current,
      );
    },
    [id, setLibrary],
  );
  const announceLibraryAuthorityLoss = useCallback(
    (message: string) =>
      setAuthorityFeedback({
        tone: "Warning",
        title: "Library access changed",
        message,
      }),
    [],
  );
  useEffect(() => {
    if (currentLibrary?.canManageMembers === true) {
      setAuthorityFeedback(null);
    }
  }, [currentLibrary?.canManageMembers]);
  useEffect(() => setAuthorityFeedback(null), [id]);
  const membersActive =
    isPaneActive &&
    paneRuntime?.secondaryPane?.groupId === "resource-inspector" &&
    paneRuntime.secondaryPane.visibility === "visible" &&
    paneRuntime.secondaryPane.activeSurfaceId === "resource-members";
  const libraryMembersController = useLibraryMembers({
    libraryId: id,
    library: currentLibrary,
    adoptLibrary,
    membersActive,
    announceAuthorityLoss: announceLibraryAuthorityLoss,
  });
  const isDefaultLibrary = knownLibrary?.isDefault === true;
  // Entry mutation (add content, reorder, remove) is hidden for system-protected
  // libraries (e.g. the Oracle Corpus), which report canEditEntries === false.
  const canEditEntries =
    currentLibrary?.role === "admin" && currentLibrary.canEditEntries === true;
  // Explicit reorder gate: Default has server-defined ordering and no reorder
  // UX/endpoint support, independent of canEditEntries (which stays true for
  // Default's "Add content" capability).
  const canReorder = canEditEntries && !isDefaultLibrary;
  // The route bootstrap seeds only Canonical + AllItems(All) at process revision
  // zero. The client claims that seed only while BOTH process revisions are still
  // zero; otherwise the exact first page loads through the entries endpoint.
  const bootstrapSeedClaimable =
    placementChange.revision === 0 && consumptionChange.revision === 0;
  // Whether a committed/requested page fetched at `captured` is stale relative to
  // the current process revisions this pane reacts to. The All (default) pane is
  // stale on any placement mismatch; a named/system pane is stale only when a
  // change SINCE its captured revision actually affected it (or was Unknown) —
  // judged across every intermediate change, not just the latest scope. Consumption
  // matters only for a consumption-sensitive view.
  const revisionsAreStale = useCallback(
    (captured: LibraryRevisions, view: LibraryEntryView): boolean => {
      const placementStale =
        placementChange.revision !== captured.placement &&
        (isDefaultLibrary ||
          libraryPlacementAffectedSince(captured.placement, id));
      const consumptionStale =
        consumptionChange.revision !== captured.consumption &&
        viewIsConsumptionSensitive(view);
      return placementStale || consumptionStale;
    },
    [
      consumptionChange.revision,
      placementChange.revision,
      id,
      isDefaultLibrary,
    ],
  );

  // The bootstrap page is adopted only for the initial Canonical + All view.
  // Every requested/committed mismatch, including a return to Canonical, owns
  // one exact-view entries request.
  const requestsFirstPage =
    view !== null &&
    (controller === null
      ? !isInitialView ||
        !allowInitialAdoptionRef.current ||
        !bootstrapSeedClaimable
      : !committedMatchesRequested || committedViewInvalidatedRef.current);
  // The resource identity carries the requested view AND a nonce so a
  // revision-stale result refetches the same view against current truth.
  const firstPageRequestKey =
    requestsFirstPage && requestedViewKey !== null
      ? `${requestedViewKey}#${firstPageNonce}`
      : null;
  const firstPageRequestPath =
    requestsFirstPage && view !== null
      ? libraryEntriesResource.clientPath({ id, view })
      : null;
  const activeFirstPageRequestKeyRef = useRef(firstPageRequestKey);
  activeFirstPageRequestKeyRef.current = firstPageRequestKey;
  const firstPageErrorKeyRef = useRef<string | null>(null);
  const firstPageResource = useResource<LibraryEntryPageResult>({
    cacheKey: firstPageRequestKey,
    load: async (signal) => {
      const requestKey = firstPageRequestKey;
      const requestedView = view;
      const requestedKey = requestedViewKey;
      const path = firstPageRequestPath;
      const revisions: LibraryRevisions = {
        placement: placementRevisionRef.current,
        consumption: consumptionRevisionRef.current,
      };
      if (
        requestKey === null ||
        requestedView === null ||
        requestedKey === null ||
        path === null
      ) {
        // justify-defect: a non-null resource key is built from this request.
        throw new Error("Library entry-view request lost its identity");
      }
      let page: unknown;
      try {
        page = await apiFetch<unknown>(path, { signal });
      } catch (requestError) {
        if (
          !isAbortError(requestError) &&
          !signal.aborted &&
          activeFirstPageRequestKeyRef.current === requestKey
        ) {
          firstPageErrorKeyRef.current = requestKey;
        }
        throw requestError;
      }
      try {
        return {
          requestKey,
          requestedViewKey: requestedKey,
          view: requestedView,
          page: decodeLibraryEntryPage(page),
          revisions,
        };
      } catch (decodeError) {
        if (
          !signal.aborted &&
          activeFirstPageRequestKeyRef.current === requestKey
        ) {
          firstPageErrorKeyRef.current = requestKey;
        }
        throw new ApiError(
          200,
          "E_INVALID_RESPONSE",
          decodeError instanceof Error
            ? decodeError.message
            : "Invalid library entries response",
        );
      }
    },
  });
  const failedFirstPage =
    firstPageRequestKey !== null &&
    firstPageResource.status === "error" &&
    firstPageErrorKeyRef.current === firstPageRequestKey
      ? {
          error: firstPageResource.error,
          retry: firstPageResource.retry,
        }
      : null;
  const firstPageError = failedFirstPage?.error ?? null;
  const entriesState: LibraryEntriesState | null =
    view === null
      ? null
      : controller === null
        ? { kind: "InitialLoading", requestedView: view }
        : committedMatchesRequested && !committedViewInvalidatedRef.current
          ? { kind: "Ready", committed: controller.entries }
          : failedFirstPage === null
            ? {
                kind: "Refreshing",
                requestedView: view,
                committed: controller.entries,
              }
            : {
                kind: "RefreshFailed",
                requestedView: view,
                committed: controller.entries,
                error: failedFirstPage.error,
              };
  const viewIsCommitted = entriesState?.kind === "Ready";

  // The owner-level generation for continuation. Advancing it aborts any page
  // in flight and makes a legitimate replacement chain distinct from a cursor
  // cycle within one chain.
  const cancelEntryLoadMore = useCallback(() => {
    setChainEpoch((epoch) => epoch + 1);
  }, []);
  useEffect(() => {
    cancelEntryLoadMore();
    consumptionOperationTokensRef.current.clear();
  }, [cancelEntryLoadMore, id]);

  const { clear: clearRemovedEntryIds } = removedEntryIds;
  const rejectPendingLibraryRevalidation = useCallback((error: unknown) => {
    const pending = pendingLibraryRevalidationRef.current;
    pendingLibraryRevalidationRef.current = null;
    completedLibraryRevalidationSerialRef.current = null;
    if (!pending) return;
    pending.removeAbortListener();
    pending.reject(error);
  }, []);
  const requestEntryReconciliation = useCallback(
    (
      requestedView: LibraryEntryView,
      revisions: LibraryRevisions,
      recovery: EntryReconciliationRequest["recovery"] = "Retry",
    ) => {
      rejectPendingLibraryRevalidation(
        new DOMException("Library refresh was superseded.", "AbortError"),
      );
      capturePaneScroll();
      cancelEntryLoadMore();
      committedSnapshotRef.current = null;
      clearAllVisitData();
      const serial = entryReconciliationSerialRef.current + 1;
      entryReconciliationSerialRef.current = serial;
      setEntryReconciliationRequest({
        ownerId: id,
        view: requestedView,
        serial,
        recovery,
        revisions,
      });
      return serial;
    },
    [
      cancelEntryLoadMore,
      capturePaneScroll,
      clearAllVisitData,
      id,
      rejectPendingLibraryRevalidation,
    ],
  );
  const revalidateLibraryEntries = useCallback(
    (signal: AbortSignal): Promise<void> => {
      if (signal.aborted) {
        return Promise.reject(
          signal.reason ??
            new DOMException("Library refresh was aborted.", "AbortError"),
        );
      }
      const current = controllerRef.current;
      const sourceKey = requestedViewKey;
      if (
        current === null ||
        sourceKey === null ||
        libraryEntriesResource.cacheKey({
          id,
          view: current.entries.view,
        }) !== sourceKey
      ) {
        return Promise.reject(
          new Error("Library refresh lost its exact committed view"),
        );
      }
      const serial = requestEntryReconciliation(current.entries.view, {
        placement: placementRevisionRef.current,
        consumption: consumptionRevisionRef.current,
      });
      return new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          const pending = pendingLibraryRevalidationRef.current;
          if (pending?.serial !== serial) return;
          pendingLibraryRevalidationRef.current = null;
          pending.removeAbortListener();
          completedLibraryRevalidationSerialRef.current = null;
          entryReconciliationSerialRef.current += 1;
          setEntryReconciliationRequest((request) =>
            request?.serial === serial ? null : request,
          );
          committedSnapshotRef.current = controllerRef.current;
          reject(
            signal.reason ??
              new DOMException("Library refresh was aborted.", "AbortError"),
          );
        };
        signal.addEventListener("abort", onAbort, { once: true });
        pendingLibraryRevalidationRef.current = {
          serial,
          sourceKey,
          resolve,
          reject,
          removeAbortListener: () =>
            signal.removeEventListener("abort", onAbort),
        };
        if (signal.aborted) onAbort();
      });
    },
    [id, requestEntryReconciliation, requestedViewKey],
  );
  useEffect(
    () => () => {
      for (const controller of podcastRowRefreshControllersRef.current) {
        controller.abort(
          new DOMException("Library refresh source was replaced.", "AbortError"),
        );
      }
      podcastRowRefreshControllersRef.current.clear();
      rejectPendingLibraryRevalidation(
        new DOMException("Library refresh source was replaced.", "AbortError"),
      );
    },
    [id, rejectPendingLibraryRevalidation, requestedViewKey],
  );
  const reconcileAfterMutation = useCallback(
    (effect: EntryMutationEffect) => {
      const current = controllerRef.current;
      if (!viewIsCommitted) {
        pendingMutationEffectRef.current =
          pendingMutationEffectRef.current === "Unknown" ? "Unknown" : effect;
        return;
      }
      if (entryReconciliationRequestRef.current !== null) {
        pendingMutationEffectRef.current =
          pendingMutationEffectRef.current === "Unknown" ? "Unknown" : effect;
        return;
      }
      if (current === null) {
        return;
      }
      if (effect === "SafeRebase") {
        clearAllVisitData();
        return;
      }
      if (effect === "SafePatch" && current.entries.exhaustion === "Complete") {
        committedSnapshotRef.current = null;
        clearAllVisitData();
        return;
      }
      requestEntryReconciliation(current.entries.view, {
        placement: libraryPlacementSnapshot().revision,
        consumption: consumptionProjectionSnapshot().revision,
      });
    },
    [clearAllVisitData, requestEntryReconciliation, viewIsCommitted],
  );
  reconcileAfterMutationRef.current = reconcileAfterMutation;
  useEffect(() => {
    if (
      !viewIsCommitted ||
      entryReconciliationRequest !== null ||
      pendingMutationEffectRef.current === null
    ) {
      return;
    }
    const effect = pendingMutationEffectRef.current;
    pendingMutationEffectRef.current = null;
    reconcileAfterMutation(effect);
  }, [entryReconciliationRequest, reconcileAfterMutation, viewIsCommitted]);
  const entryReconciliationParams: LibraryEntriesResourceParams | null =
    entryReconciliationRequest
      ? {
          id: entryReconciliationRequest.ownerId,
          view: entryReconciliationRequest.view,
        }
      : null;
  const entryReconciliationPath = entryReconciliationParams
    ? libraryEntriesResource.clientPath(entryReconciliationParams)
    : null;
  const entryReconciliationFetch = useDebouncedFetch<EntryReconciliationResult>(
    entryReconciliationParams && entryReconciliationRequest
      ? `${libraryEntriesResource.cacheKey(entryReconciliationParams)}:reconcile:${entryReconciliationRequest.serial}`
      : null,
    async (signal) => {
      const request = entryReconciliationRequest;
      const path = entryReconciliationPath;
      if (request === null || path === null) {
        // justify-defect: a non-null reconciliation query key is constructed
        // from the same request/path pair consumed by this query function.
        throw new Error("Library entry reconciliation lost its query identity");
      }
      return {
        request,
        page: decodeLibraryEntryPage(await apiFetch<unknown>(path, { signal })),
      };
    },
    { debounceMs: 0 },
  );
  useEffect(() => {
    const request = entryReconciliationRequest;
    const requestError = entryReconciliationFetch.error;
    const pending = pendingLibraryRevalidationRef.current;
    if (
      request === null ||
      requestError === null ||
      pending?.serial !== request.serial
    ) {
      return;
    }
    entryReconciliationSerialRef.current += 1;
    setEntryReconciliationRequest(null);
    committedSnapshotRef.current = controllerRef.current;
    rejectPendingLibraryRevalidation(requestError);
  }, [
    entryReconciliationFetch.error,
    entryReconciliationRequest,
    rejectPendingLibraryRevalidation,
  ]);
  useEffect(() => {
    if (
      entryReconciliationRequest?.recovery !== "RefreshList" ||
      entryReconciliationFetch.error === null
    ) {
      return;
    }
    const scope =
      listRegionRef.current?.closest<HTMLElement>("[data-pane-content]") ??
      document;
    const button = Array.from(
      scope.querySelectorAll<HTMLButtonElement>("button"),
    ).find((candidate) => candidate.textContent?.trim() === "Refresh list");
    button?.focus();
  }, [entryReconciliationFetch.error, entryReconciliationRequest]);

  useEffect(() => {
    const result = entryReconciliationFetch.data;
    const request = entryReconciliationRequest;
    if (
      result === null ||
      request === null ||
      request.ownerId !== id ||
      result.request.ownerId !== request.ownerId ||
      result.request.serial !== request.serial
    ) {
      return;
    }
    const requestViewKey = libraryEntriesResource.cacheKey({
      id: request.ownerId,
      view: request.view,
    });
    const resultViewKey = libraryEntriesResource.cacheKey({
      id: result.request.ownerId,
      view: result.request.view,
    });
    if (
      !viewIsCommitted ||
      requestViewKey !== resultViewKey ||
      requestViewKey !== requestedViewKey ||
      requestViewKey !== committedViewKey
    ) {
      // The requested view moved on: the first-page path owns the new view. Drop
      // this result; the revision trigger re-fires if the current view is still
      // behind its committed baseline.
      if (pendingLibraryRevalidationRef.current?.serial === request.serial) {
        rejectPendingLibraryRevalidation(
          new DOMException(
            "Library refresh source was replaced.",
            "AbortError",
          ),
        );
      }
      setEntryReconciliationRequest(null);
      return;
    }
    cancelEntryLoadMore();
    clearRemovedEntryIds();
    setController((current) =>
      current === null ||
      libraryEntriesResource.cacheKey({
        id,
        view: current.entries.view,
      }) !== requestViewKey
        ? current
        : {
            ...current,
            entries: {
              view: result.request.view,
              entries: result.page.items,
              collectionRevision: result.page.collectionRevision,
              nextCursor: result.page.nextCursor,
              exhaustion:
                result.page.nextCursor.kind === "Absent"
                  ? "Complete"
                  : "Partial",
              revisions: result.request.revisions,
            },
          },
    );
    // The committed baseline advances to the revisions captured when this
    // reconciliation was requested, so a mutation that landed while it was in
    // flight surfaces as exactly one coalesced follow-up.
    committedRevisionsRef.current = result.request.revisions;
    if (pendingLibraryRevalidationRef.current?.serial === request.serial) {
      completedLibraryRevalidationSerialRef.current = request.serial;
    }
    setEntryReconciliationRequest(null);
    focusPendingControl();
  }, [
    cancelEntryLoadMore,
    clearRemovedEntryIds,
    committedViewKey,
    entryReconciliationFetch.data,
    entryReconciliationRequest,
    focusPendingControl,
    id,
    requestedViewKey,
    rejectPendingLibraryRevalidation,
    viewIsCommitted,
  ]);

  // Revision-driven reconciliation: while the committed view is showing and a
  // reacted-to placement/consumption advance has moved past its baseline,
  // reconcile the current view. One reconciliation is in flight at a time; the
  // commit re-bases to the request's captured revisions, so a mutation during
  // flight yields exactly one follow-up.
  useEffect(() => {
    if (!isPaneActive) return;
    if (!viewIsCommitted || controller === null) return;
    if (entryReconciliationRequest !== null) return;
    if (
      consumptionOperationTokensRef.current.size > 0 ||
      resettingProgressMediaIds.ids.size > 0 ||
      deletingMediaIds.ids.size > 0 ||
      unsubscribingPodcastIds.ids.size > 0
    ) {
      return;
    }
    const current: LibraryRevisions = {
      placement: placementChange.revision,
      consumption: consumptionChange.revision,
    };
    if (
      !revisionsAreStale(committedRevisionsRef.current, controller.entries.view)
    ) {
      return;
    }
    requestEntryReconciliation(controller.entries.view, current);
  }, [
    consumptionChange.revision,
    controller,
    deletingMediaIds.ids,
    entryReconciliationRequest,
    isPaneActive,
    placementChange.revision,
    requestEntryReconciliation,
    resettingProgressMediaIds.ids,
    revisionsAreStale,
    unsubscribingPodcastIds.ids,
    viewIsCommitted,
  ]);

  useEffect(() => {
    entryReconciliationSerialRef.current += 1;
    pendingMutationEffectRef.current = null;
    setEntryReconciliationRequest(null);
  }, [id]);

  // The route resource seeds Canonical + All once. A factual deep link waits for
  // its exact entries page; invalid URL state retains the seed only so Reset can
  // return to a coherent canonical snapshot.
  useEffect(() => {
    if (libraryResource.status === "ready") {
      if (!allowInitialAdoptionRef.current) return;
      allowInitialAdoptionRef.current = false;
      if ((isInitialView || view === null) && bootstrapSeedClaimable) {
        committedViewInvalidatedRef.current = false;
        // The bootstrap seed is only claimed at process revision zero, so its
        // committed baseline is exactly {0, 0}. A later advance reconciles it.
        const seedRevisions: LibraryRevisions = {
          placement: 0,
          consumption: 0,
        };
        committedRevisionsRef.current = seedRevisions;
        setController({
          library: libraryResource.data.library,
          entries: {
            view: view ?? CANONICAL_LIBRARY_VIEW,
            entries: libraryResource.data.entries,
            collectionRevision: libraryResource.data.collectionRevision,
            nextCursor: libraryResource.data.nextCursor,
            exhaustion: libraryResource.data.exhaustion,
            revisions: seedRevisions,
          },
        });
      }
      setError(null);
      return;
    }

    if (libraryResource.status === "error") {
      cancelEntryLoadMore();
      if (
        isApiError(libraryResource.error) &&
        libraryResource.error.status === 404
      ) {
        router.push("/libraries");
        return;
      }
      presentFailure(
        libraryResource.error,
        "Library couldn’t be loaded",
        "LibraryRead",
        {
          label: "Retry",
          onClick: libraryResource.retry,
        },
      );
      setController(null);
    }
  }, [
    bootstrapSeedClaimable,
    cancelEntryLoadMore,
    id,
    isInitialView,
    libraryResource,
    presentFailure,
    router,
    view,
  ]);

  // A view request (or a revision-stale refetch) invalidates view-sensitive work
  // but preserves the committed page until its exact replacement is ready.
  useEffect(() => {
    if (firstPageRequestKey === null) return;
    committedViewInvalidatedRef.current = true;
    reorderGenerationRef.current += 1;
    setReorderBusy(false);
    cancelEntryLoadMore();
    clearRemovedEntryIds();
    clearAllVisitData();
    setViewInvalid(false);
    entryReconciliationSerialRef.current += 1;
    setEntryReconciliationRequest(null);
  }, [
    cancelEntryLoadMore,
    clearRemovedEntryIds,
    clearAllVisitData,
    firstPageRequestKey,
  ]);

  // Install only the response for the current requested view whose captured
  // revisions still match; a revision that advanced mid-request means the result
  // is stale, so refetch the same view once against current truth.
  useEffect(() => {
    if (
      firstPageResource.status !== "ready" ||
      firstPageRequestKey === null ||
      firstPageResource.data.requestKey !== firstPageRequestKey ||
      requestedViewKey !== firstPageResource.data.requestedViewKey
    ) {
      return;
    }
    if (
      revisionsAreStale(
        firstPageResource.data.revisions,
        firstPageResource.data.view,
      )
    ) {
      setFirstPageNonce((nonce) => nonce + 1);
      return;
    }
    const library =
      controller?.library ??
      (libraryResource.status === "ready"
        ? libraryResource.data.library
        : null);
    if (library === null) return;
    cancelEntryLoadMore();
    clearRemovedEntryIds();
    committedViewInvalidatedRef.current = false;
    const committedRevisions: LibraryRevisions = {
      placement: placementRevisionRef.current,
      consumption: consumptionRevisionRef.current,
    };
    committedRevisionsRef.current = committedRevisions;
    setController({
      library,
      entries: {
        view: firstPageResource.data.view,
        entries: firstPageResource.data.page.items,
        collectionRevision: firstPageResource.data.page.collectionRevision,
        nextCursor: firstPageResource.data.page.nextCursor,
        exhaustion:
          firstPageResource.data.page.nextCursor.kind === "Absent"
            ? "Complete"
            : "Partial",
        revisions: committedRevisions,
      },
    });
    setViewInvalid(false);
    focusPendingControl();
  }, [
    cancelEntryLoadMore,
    clearRemovedEntryIds,
    controller?.library,
    firstPageRequestKey,
    firstPageResource,
    focusPendingControl,
    libraryResource,
    requestedViewKey,
    revisionsAreStale,
  ]);

  // The pane-level spinner is reserved for the pre-metadata state: no committed
  // page AND no route-resource metadata yet. Once metadata is known the pane
  // renders its toolbar and the polite status node instead.
  const loading =
    knownLibrary === null &&
    !observedLibraryUnavailable &&
    error === null &&
    (libraryResource.status === "loading" ||
      (firstPageRequestKey !== null && firstPageError === null));
  useSetPaneLabel(
    knownLibrary
      ? libraryPresentation(knownLibrary).name
      : loading
        ? null
        : "Library",
  );

  useEffect(() => {
    if (isInvalidViewError(firstPageError)) {
      setViewInvalid(true);
    }
  }, [firstPageError]);

  useLayoutEffect(() => {
    committedSnapshotRef.current =
      entriesState?.kind === "Ready" && entryReconciliationRequest === null
        ? controller
        : null;
  }, [controller, entriesState?.kind, entryReconciliationRequest]);
  useEffect(() => {
    const pending = pendingLibraryRevalidationRef.current;
    if (
      pending === null ||
      completedLibraryRevalidationSerialRef.current !== pending.serial ||
      entryReconciliationRequest !== null ||
      requestedViewKey !== pending.sourceKey ||
      committedSnapshotRef.current === null
    ) {
      return;
    }
    pendingLibraryRevalidationRef.current = null;
    completedLibraryRevalidationSerialRef.current = null;
    pending.removeAbortListener();
    pending.resolve();
  }, [controller, entryReconciliationRequest, requestedViewKey]);
  useLayoutEffect(() => {
    const scrollTop = pendingScrollTopRef.current;
    if (scrollTop === null) return;
    const region = document.getElementById(`library-entry-region-${id}`);
    const scrollport = region?.closest<HTMLElement>("[data-pane-content]");
    if (!scrollport) return;
    scrollport.scrollTop = scrollTop;
    const frame = requestAnimationFrame(() => {
      scrollport.scrollTop = scrollTop;
      pendingScrollTopRef.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [controller, id]);

  usePaneReturnReady(
    entriesState?.kind === "Ready" ||
      entriesState?.kind === "RefreshFailed" ||
      view === null ||
      viewInvalid ||
      firstPageError !== null ||
      error !== null,
  );

  // Reading-slate intake writes the same library-entry contract as placement.
  const acceptSlateTarget = useCallback<ReadingSlateAccept>(
    (target, options) => {
      if (!viewIsCommitted || committedView === null) {
        return Promise.resolve({ kind: "Abandoned" });
      }
      const targetId = slateTargetId(target);
      const clientMutationId = crypto.randomUUID();
      const frozenAttempt = () =>
        addLibraryPlacement(
          { kind: target.kind, id: targetId },
          id,
          { clientMutationId },
        );

      return new Promise((resolve) => {
        let observing = true;
        let inFlight = false;
        const abandon = () => {
          if (!observing) return;
          observing = false;
          resolve({ kind: "Abandoned" });
        };
        const runAttempt = () => {
          if (!observing || inFlight) return;
          inFlight = true;
          void frozenAttempt().then(
            () => {
              inFlight = false;
              if (!observing) return;
              observing = false;
              options.signal.removeEventListener("abort", abandon);
              // The placement writer already published to the placement
              // revision store; that revision reconciles the committed view.
              resolve({ kind: "Accepted" });
            },
            (error: unknown) => {
              inFlight = false;
              if (!observing) return;
              if (handleUnauthenticatedApiError(error)) {
                observing = false;
                options.signal.removeEventListener("abort", abandon);
                resolve({ kind: "Abandoned" });
                return;
              }
              if (!isApiError(error)) {
                observing = false;
                options.signal.removeEventListener("abort", abandon);
                setDefect({ error });
                resolve({ kind: "Abandoned" });
                return;
              }
              const apiError = error;
              try {
                libraryRequestErrorMessage(
                  apiError,
                  {
                    title: "Item wasn’t added",
                    request: "PlacementMutation",
                  },
                );
              } catch (caughtDefect) {
                observing = false;
                options.signal.removeEventListener("abort", abandon);
                setDefect({ error: caughtDefect });
                resolve({ kind: "Abandoned" });
                return;
              }
              if (apiError.status >= 400 && apiError.status < 500) {
                observing = false;
                options.signal.removeEventListener("abort", abandon);
                resolve({ kind: "Rejected", error: apiError });
                return;
              }
              options.onUnknown({
                error: apiError,
                recovery: { kind: "Local", retry: runAttempt },
              });
            },
          );
        };

        if (options.signal.aborted) {
          abandon();
          return;
        }
        options.signal.addEventListener("abort", abandon, { once: true });
        runAttempt();
      });
    },
    [committedView, id, viewIsCommitted],
  );

  const runMediaProcessingMutation = useCallback(
    async (args: {
      mediaId: string;
      busySet: StringIdSet;
      action: "retry" | "refresh";
      successTitle: string;
      errorTitle: string;
    }) => {
      if (args.busySet.has(args.mediaId)) return;
      args.busySet.add(args.mediaId);
      try {
        const projection = await runSourceProcessingAction({
          mediaId: args.mediaId,
          action: args.action,
          successTitle: args.successTitle,
        });
        patchMediaInViews(args.mediaId, (media) => ({
          ...media,
          processing_status: projection.processingStatus,
          capabilities: {
            ...media.capabilities,
            ...projection.capabilityPatch,
          },
        }));
        clearAllVisitData();
        reconcileAfterMutationRef.current("SafePatch");
      } catch (err) {
        if (handleUnauthenticatedApiError(err)) return;
        presentFailure(err, args.errorTitle, "EntryMutation");
      } finally {
        args.busySet.remove(args.mediaId);
      }
    },
    [clearAllVisitData, patchMediaInViews, presentFailure],
  );

  const handleRetryProcessing = useCallback(
    (mediaId: string) =>
      runMediaProcessingMutation({
        mediaId,
        busySet: retryingMediaIds,
        action: "retry",
        successTitle: "Processing retry started.",
        errorTitle: "Processing retry wasn’t started",
      }),
    [retryingMediaIds, runMediaProcessingMutation],
  );

  const handleRefreshSource = useCallback(
    (mediaId: string) =>
      runMediaProcessingMutation({
        mediaId,
        busySet: refreshingMediaIds,
        action: "refresh",
        successTitle: "Source refresh started.",
        errorTitle: "Source refresh wasn’t started",
      }),
    [refreshingMediaIds, runMediaProcessingMutation],
  );

  const handleRetryMetadata = useCallback(
    async (mediaId: string) => {
      if (retryingMetadataMediaIds.has(mediaId)) return;
      retryingMetadataMediaIds.add(mediaId);
      try {
        await retryMediaMetadata(mediaId);
        clearAllVisitData();
        reconcileAfterMutationRef.current("Unknown");
      } catch (metadataError) {
        if (handleUnauthenticatedApiError(metadataError)) return;
        presentFailure(
          metadataError,
          "Metadata enrichment wasn’t started",
          "EntryMutation",
        );
      } finally {
        retryingMetadataMediaIds.remove(mediaId);
      }
    },
    [clearAllVisitData, presentFailure, retryingMetadataMediaIds],
  );

  const handleDeleteMedia = useCallback(
    async (entry: LibraryMediaListItem) => {
      if (deletingMediaIds.has(entry.media.id)) return;
      deletingMediaIds.add(entry.media.id);

      try {
        const outcome = await confirmAndDeleteMedia({
          mediaId: entry.media.id,
          mediaTitle: entry.media.title,
          confirmRemoval: (message) => window.confirm(message),
        });
        if (outcome.kind === "Cancelled") return;
        captureFocusNeighbor(libraryRowKey(entry, isDefaultLibrary));
        const { result } = outcome;
        // The row leaves the pane whether the media was removed, hidden, or is
        // still being deleted server-side.
        setEntries((current) =>
          current.filter(
            (candidate) =>
              candidate.kind !== "media" ||
              candidate.media.id !== entry.media.id,
          ),
        );
        if (result.kind !== "Deleting") {
          committedRevisionsRef.current = {
            ...committedRevisionsRef.current,
            placement: libraryPlacementSnapshot().revision,
          };
        }
        if (result.kind === "Deleting") {
          clearAllVisitData();
          reconcileAfterMutationRef.current("Unknown");
        } else {
          installEntryCollectionRevision(
            result.libraryEntriesCollectionRevision,
          );
          reconcileAfterMutationRef.current("SafeRebase");
        }
      } catch (err) {
        if (handleUnauthenticatedApiError(err)) return;
        presentFailure(err, "Media wasn’t removed", "EntryMutation");
      } finally {
        deletingMediaIds.remove(entry.media.id);
      }
    },
    [
      clearAllVisitData,
      captureFocusNeighbor,
      deletingMediaIds,
      installEntryCollectionRevision,
      isDefaultLibrary,
      presentFailure,
      setEntries,
    ],
  );

  const handleSetConsumption = useCallback(
    async (mediaId: string, status: "finished" | "unread") => {
      if (
        updatingConsumptionMediaIds.has(mediaId) ||
        resettingProgressMediaIds.has(mediaId)
      ) {
        clearPendingFocusNeighbor();
        return;
      }
      updatingConsumptionMediaIds.add(mediaId);
      const previous = new Map<string, LibraryMediaConsumption>();
      for (const entry of entries) {
        if (entry.kind === "media" && entry.media.id === mediaId) {
          previous.set(libraryTargetId(entry), {
            read_state: entry.media.read_state,
            progress_fraction: entry.media.progress_fraction,
          });
        }
      }
      if (previous.size === 0) {
        clearPendingFocusNeighbor();
        updatingConsumptionMediaIds.remove(mediaId);
        throw new Error(`Library media ${mediaId} is not present`);
      }
      const operationToken = Symbol(mediaId);
      consumptionOperationTokensRef.current.set(mediaId, operationToken);
      patchMediaInViews(mediaId, (media) => ({
        ...media,
        read_state: status,
      }));

      try {
        let result: ConsumptionResult;
        if (status === "finished") {
          const parsedMediaId = parseMediaId(mediaId);
          const preCompletionSnapshot = lectern.getCanonicalSnapshot() ?? {
            items: [],
          };
          const completedItem =
            preCompletionSnapshot.items.find(
              (item) => item.mediaId === mediaId,
            ) ?? null;
          result = await lectern.ensureMediaFinished(parsedMediaId);
          offerCompletionUndo({
            mediaId: parsedMediaId,
            preCompletionSnapshot,
            completedItemId: completedItem?.itemId ?? null,
            completionHandle: result.completionHandle,
          });
        } else {
          result = await lectern.setUnread(parseMediaId(mediaId));
        }
        committedRevisionsRef.current = {
          ...committedRevisionsRef.current,
          consumption: consumptionProjectionSnapshot().revision,
        };
        installEntryCollectionRevision(result.libraryEntriesCollectionRevision);
        reconcileAfterMutationRef.current("SafeRebase");
      } catch (err) {
        clearPendingFocusNeighbor();
        if (
          consumptionOperationTokensRef.current.get(mediaId) !== operationToken
        ) {
          return;
        }
        setEntries((current) =>
          current.map((entry) => {
            const fields = previous.get(libraryTargetId(entry));
            return entry.kind === "media" &&
              entry.media.id === mediaId &&
              fields
              ? { ...entry, media: { ...entry.media, ...fields } }
              : entry;
          }),
        );
        if (handleUnauthenticatedApiError(err)) return;
        presentFailure(err, "Read state wasn’t updated", "EntryMutation");
      } finally {
        if (
          consumptionOperationTokensRef.current.get(mediaId) === operationToken
        ) {
          consumptionOperationTokensRef.current.delete(mediaId);
        }
        updatingConsumptionMediaIds.remove(mediaId);
      }
    },
    [
      entries,
      clearPendingFocusNeighbor,
      installEntryCollectionRevision,
      lectern,
      offerCompletionUndo,
      patchMediaInViews,
      presentFailure,
      setEntries,
      resettingProgressMediaIds,
      updatingConsumptionMediaIds,
    ],
  );

  const handleResetProgress = useCallback(
    async (
      mediaId: string,
      isVideo: boolean,
      removedRowKey: string | null,
    ) => {
      if (
        resettingProgressMediaIds.has(mediaId) ||
        updatingConsumptionMediaIds.has(mediaId)
      ) {
        clearPendingFocusNeighbor();
        return;
      }
      if (!viewIsCommitted || committedView === null) {
        clearPendingFocusNeighbor();
        return;
      }
      resettingProgressMediaIds.add(mediaId);
      try {
        const outcome = await runProgressReset({
          mediaId: parseMediaId(mediaId),
          isVideo,
          confirmReset: (message) => window.confirm(message),
          resetProgress: lectern.resetProgress,
        });
        if (outcome.kind === "Cancelled") {
          clearPendingFocusNeighbor();
          return;
        }
        if (removedRowKey !== null) {
          captureFocusNeighbor(removedRowKey);
        }
        // Immediate local patch: Reset removes the row from an In Progress view.
        // lectern.resetProgress already published the consumption revision, so a
        // consumption-sensitive view reconciles against fresh truth.
        patchMediaInViews(mediaId, (media) => ({
          ...media,
          read_state: "unread",
        }));
        committedRevisionsRef.current = {
          ...committedRevisionsRef.current,
          consumption: consumptionProjectionSnapshot().revision,
        };
        installEntryCollectionRevision(
          outcome.result.libraryEntriesCollectionRevision,
        );
        reconcileAfterMutationRef.current("SafeRebase");
      } catch (error) {
        clearPendingFocusNeighbor();
        if (handleUnauthenticatedApiError(error)) return;
        presentFailure(error, "Progress wasn’t reset", "EntryMutation");
      } finally {
        resettingProgressMediaIds.remove(mediaId);
      }
    },
    [
      committedView,
      clearPendingFocusNeighbor,
      captureFocusNeighbor,
      installEntryCollectionRevision,
      lectern.resetProgress,
      patchMediaInViews,
      presentFailure,
      resettingProgressMediaIds,
      updatingConsumptionMediaIds,
      viewIsCommitted,
    ],
  );

  const handleAddToLectern = useCallback(
    async (mediaId: string) => {
      if (addingToLecternMediaIds.has(mediaId)) return;
      addingToLecternMediaIds.add(mediaId);
      try {
        await lectern.placeItems({
          mediaIds: [parseMediaId(mediaId)],
          placement: { kind: "Last" },
        });
        clearAllVisitData();
      } catch (err) {
        if (handleUnauthenticatedApiError(err)) return;
        presentFailure(err, "Item wasn’t added to Lectern", "LecternMutation");
      } finally {
        addingToLecternMediaIds.remove(mediaId);
      }
    },
    [addingToLecternMediaIds, clearAllVisitData, lectern, presentFailure],
  );

  const handleRemoveFromLectern = useCallback(
    async (mediaId: string, itemId: LecternItemId) => {
      if (removingFromLecternMediaIds.has(mediaId)) return;
      removingFromLecternMediaIds.add(mediaId);
      try {
        await lectern.removeItem(itemId);
        clearAllVisitData();
      } catch (removeError) {
        if (handleUnauthenticatedApiError(removeError)) return;
        presentFailure(
          removeError,
          "Item wasn’t removed from Lectern",
          "LecternMutation",
        );
      } finally {
        removingFromLecternMediaIds.remove(mediaId);
      }
    },
    [clearAllVisitData, lectern, presentFailure, removingFromLecternMediaIds],
  );

  const handleRefreshPodcast = async (
    entry: LibraryPodcastListItem,
  ): Promise<void> => {
    const podcastId = entry.podcast.id;
    if (refreshingPodcastIds.has(podcastId)) return;
    refreshingPodcastIds.add(podcastId);
    setError(null);
    const controller = new AbortController();
    podcastRowRefreshControllersRef.current.add(controller);
    try {
      const result = await runPodcastRefresh(
        { kind: "Podcast", podcastId },
        {
          signal: controller.signal,
          onProgress: () => {},
        },
      );
      await revalidateLibraryEntries(controller.signal);
      if (result.kind !== "Complete") {
        setError({
          content: {
            tone: result.kind === "Failed" ? "Danger" : "Warning",
            title: result.announcement,
          },
          actions: [
            {
              label: "Retry",
              onClick: () => void handleRefreshPodcast(entry),
            },
          ],
        });
      }
    } catch (refreshError) {
      if (isAbortError(refreshError)) return;
      if (handleUnauthenticatedApiError(refreshError)) return;
      presentFailure(
        refreshError,
        "Podcast wasn’t refreshed",
        "PodcastMutation",
        {
          label: "Retry",
          onClick: () => void handleRefreshPodcast(entry),
        },
      );
    } finally {
      podcastRowRefreshControllersRef.current.delete(controller);
      refreshingPodcastIds.remove(podcastId);
    }
  };

  const handleUnsubscribePodcast = async (
    entry: LibraryPodcastListItem,
  ): Promise<void> => {
    const podcastId = entry.podcast.id;
    if (unsubscribingPodcastIds.has(podcastId)) return;
    unsubscribingPodcastIds.add(podcastId);
    try {
      const placements = await listLibraryPlacements({
        kind: "Podcast",
        id: podcastId,
      });
      if (
        !confirm(
          buildPodcastUnsubscribeConfirmation(entry.podcast.title, placements),
        )
      ) {
        return;
      }
      const result = await unsubscribeFromPodcast(podcastId);
      const currentPlacement = placements.find(
        (placement) => placement.id === id,
      );
      if (currentPlacement?.canRemove) {
        captureFocusNeighbor(libraryRowKey(entry, isDefaultLibrary));
      }
      setEntries((current) =>
        current.flatMap((candidate) => {
          if (
            candidate.kind !== "podcast" ||
            candidate.podcast.id !== podcastId
          ) {
            return [candidate];
          }
          return isDefaultLibrary || currentPlacement?.canRemove
            ? []
            : [
                {
                  ...candidate,
                  subscription: { kind: "Absent" as const },
                  podcast: {
                    ...candidate.podcast,
                    syncStatus: { kind: "Absent" as const },
                  },
                },
              ];
        }),
      );
      committedRevisionsRef.current = {
        ...committedRevisionsRef.current,
        placement: libraryPlacementSnapshot().revision,
      };
      installEntryCollectionRevision(result.libraryEntriesCollectionRevision);
      reconcileAfterMutationRef.current("SafeRebase");
    } catch (unsubscribeError) {
      if (handleUnauthenticatedApiError(unsubscribeError)) return;
      presentFailure(
        unsubscribeError,
        "Podcast wasn’t unsubscribed",
        "PodcastMutation",
      );
    } finally {
      unsubscribingPodcastIds.remove(podcastId);
    }
  };

  // Delete library and Library settings are canonical resource actions now: the
  // pane publishes its resourceTarget and the app runtime dispatches
  // DeleteLibrary (confirm + client + reconcile) and LibrarySettings (overlay).

  // Continuation recovery replaces the exact committed view's first page while
  // preserving its rendered rows until the replacement commits.
  const handleRefreshList = useCallback(() => {
    if (committedView === null) return;
    pendingCommitFocusRef.current = "View";
    requestEntryReconciliation(
      committedView,
      {
        placement: placementRevisionRef.current,
        consumption: consumptionRevisionRef.current,
      },
      "RefreshList",
    );
  }, [committedView, requestEntryReconciliation]);

  const loadEntryPage = useCallback(
    async (
      cursor: CollectionCursor,
      revision: CollectionRevision,
      signal: AbortSignal,
    ): Promise<LibraryEntryPage> => {
      const exactView = controllerRef.current?.entries.view;
      if (exactView === undefined) {
        throw new Error("Library continuation lost its committed view");
      }
      return decodeLibraryEntryPage(
        await apiFetch<unknown>(
          libraryEntriesResource.clientPath({
            id,
            view: exactView,
            cursor,
            collectionRevision: revision,
            limit: 100,
          }),
          { signal },
        ),
      );
    },
    [id],
  );
  const commitEntryPage = useCallback((page: LibraryEntryPage): number => {
      const current = controllerRef.current;
      if (
        current === null ||
        page.collectionRevision !== current.entries.collectionRevision
      ) {
        throw new Error("Library continuation revision mismatch");
      }
      const merged = appendUniqueEntries(
        [...current.entries.entries],
        page.items,
        (entry) => libraryRowKey(entry, current.library.isDefault),
      );
      const next: LibrarySnapshot = {
        ...current,
        entries: {
          ...current.entries,
          entries: merged,
          nextCursor: page.nextCursor,
        exhaustion: page.nextCursor.kind === "Absent" ? "Complete" : "Partial",
        },
      };
      controllerRef.current = next;
      committedSnapshotRef.current = next;
      setController(next);
      return merged.length;
  }, []);
  const entryExhaustion = useExhaustivePagination({
    active:
      isPaneActive &&
      viewIsCommitted &&
      controller !== null &&
      entryReconciliationRequest === null,
    chainKey: [
      id,
      committedViewKey ?? "uncommitted",
      controller?.entries.collectionRevision ?? ZERO_COLLECTION_REVISION,
      chainEpoch,
    ].join(":"),
    cursor: entryCursor,
    collectionRevision:
      controller?.entries.collectionRevision ?? ZERO_COLLECTION_REVISION,
    itemCount: entries.length,
    loadPage: loadEntryPage,
    commitPage: commitEntryPage,
    refresh: handleRefreshList,
  });

  const handleReorderEntries = (nextEntries: LibraryEntry[]) => {
    if (
      !viewIsCommitted ||
      !canReorder ||
      controller?.entries.exhaustion !== "Complete" ||
      entryExhaustion.kind !== "Complete"
    ) {
      return;
    }
    const generation = reorderGenerationRef.current + 1;
    reorderGenerationRef.current = generation;
    const previousEntries = entries;
    setEntries(nextEntries);
    setReorderBusy(true);
    setError(null);
    void apiFetch(`/api/libraries/${id}/entries/reorder`, {
      method: "PATCH",
      body: JSON.stringify({
        entry_ids: nextEntries.map((entry) => {
          if (entry.placement.kind !== "Present") {
            throw new Error("Virtual Library rows cannot be reordered");
          }
          return entry.placement.value.libraryEntryId;
        }),
      }),
    })
      .then(() => {
        if (generation !== reorderGenerationRef.current) return;
        clearAllVisitData();
        reconcileAfterMutationRef.current("Unknown");
      })
      .catch((err: unknown) => {
        if (generation !== reorderGenerationRef.current) return;
        setEntries(previousEntries);
        if (handleUnauthenticatedApiError(err)) return;
        presentFailure(
          err,
          "Library entries weren’t reordered",
          "EntryMutation",
        );
      })
      .finally(() => {
        if (generation !== reorderGenerationRef.current) return;
        setReorderBusy(false);
      });
  };

  const addContentAction: ActionDescriptor[] =
    currentLibrary && canEditEntries && viewIsCommitted
      ? [
          {
            kind: "command",
            id: "ViewAction.Library.AddContent",
            label: "Add content",
            restoreFocusOnClose: false,
            onSelect: () =>
              requestNexusOpen({
                kind: "Add",
                seed: {
                  kind: "Content",
                  initialFocus: "Url",
                  initialDestinations: currentLibrary.isDefault
                    ? []
                    : [
                        {
                          id: currentLibrary.id,
                          name: currentLibrary.name,
                          color: currentLibrary.color,
                        },
                      ],
                },
              }),
          },
        ]
      : [];

  const hideFinished =
    committedView !== null && completionOf(committedView) === "unfinished";
  const isInProgressView = committedView?.projection.kind === "InProgress";
  // Immediate local filtering mirrors the committed projection so a consumption
  // mutation removes a row before its reconciliation lands: under the unfinished
  // filter a newly-finished media row drops out; under In Progress a media row
  // that is no longer in_progress (Mark Finished/Unread/Reset) drops out.
  const isVisibleEntry = useCallback(
    (entry: LibraryEntry): boolean => {
      if (removedEntryIds.ids.has(libraryTargetId(entry))) return false;
      if (entry.kind !== "media") return true;
      if (hideFinished && entry.media.read_state === "finished") {
        return false;
      }
      if (isInProgressView && entry.media.read_state !== "in_progress") {
        return false;
      }
      return true;
    },
    [hideFinished, isInProgressView, removedEntryIds.ids],
  );
  const visibleEntries = useMemo(
    () => entries.filter(isVisibleEntry),
    [entries, isVisibleEntry],
  );
  const entryCollectionComplete =
    controller?.entries.exhaustion === "Complete" &&
    entryExhaustion.kind === "Complete";
  const invalidView = decodedView.kind === "Invalid" || viewInvalid;
  const orderPresetIds = useMemo(
    () => orderPresetIdsFor(isDefaultLibrary),
    [isDefaultLibrary],
  );
  const projectionOptions = useMemo(
    () => projectionOptionsFor(isDefaultLibrary),
    [isDefaultLibrary],
  );
  const dismissFilterQueryRef = useRef<() => void>(() => undefined);
  const clearDomainFilters = useCallback(() => {
    dismissFilterQueryRef.current();
    pendingCommitFocusRef.current = "View";
    setView(CANONICAL_LIBRARY_VIEW);
  }, [setView]);
  const domainFilterControls = useMemo(
    () =>
      invalidView || view === null ? undefined : (
        <>
          <label className={styles.selectField}>
            <span>Type</span>
            <Select
              ref={typeSelectRef}
              value={entryTypeOptionOf(view)}
              onChange={(event) => {
                pendingCommitFocusRef.current = "Type";
                setView(
                  withEntryTypeOption(
                    view,
                    event.target.value as LibraryEntryTypeOptionId,
                  ),
                );
              }}
            >
              {LIBRARY_ENTRY_TYPE_OPTION_IDS.map((optionId) => (
                <option key={optionId} value={optionId}>
                  {entryTypeOptionLabel(optionId)}
                </option>
              ))}
            </Select>
          </label>
          <label className={styles.selectField}>
            <span>View</span>
            <Select
              ref={viewSelectRef}
              value={projectionOptionOf(view)}
              onChange={(event) => {
                pendingCommitFocusRef.current = "View";
                setView(
                  withProjectionOption(
                    view,
                    event.target.value as ProjectionOptionId,
                  ),
                );
              }}
            >
              {projectionOptions.map((optionId) => (
                <option key={optionId} value={optionId}>
                  {projectionOptionLabel(optionId)}
                </option>
              ))}
            </Select>
          </label>
          <label className={styles.selectField}>
            <span>Sort by</span>
            <Select
              ref={sortSelectRef}
              value={orderToPresetId(view.order)}
              onChange={(event) => {
                pendingCommitFocusRef.current = "Sort";
                setView({
                  order: presetIdToOrder(
                    event.target.value as LibraryOrderPresetId,
                  ),
                  projection: view.projection,
                  entryType: view.entryType,
                });
              }}
            >
              {orderPresetIds.map((presetId) => (
                <option key={presetId} value={presetId}>
                  {presetLabel(presetId, isDefaultLibrary)}
                </option>
              ))}
            </Select>
          </label>
          {projectionSupportsCompletion(view) ? (
            <Toggle
              id={hideFinishedInputId}
              checked={completionOf(view) === "unfinished"}
              onCheckedChange={(checked) => {
                pendingCommitFocusRef.current = "HideFinished";
                setView(withCompletion(view, checked ? "unfinished" : "all"));
              }}
              label="Hide finished"
            />
          ) : null}
          {entryTypeOptionOf(view) !== "all-types" ||
          projectionOptionOf(view) !== "all-items" ||
          view.order.kind !== "Canonical" ||
          completionOf(view) === "unfinished" ? (
            <Button variant="secondary" size="sm" onClick={clearDomainFilters}>
              Clear filters
            </Button>
          ) : null}
        </>
      ),
    [
      clearDomainFilters,
      hideFinishedInputId,
      invalidView,
      isDefaultLibrary,
      orderPresetIds,
      projectionOptions,
      setView,
      view,
    ],
  );
  const activeDomainControlCount =
    view === null ? 0 : activeLibraryDomainControlCount(view);
  const getFilterStatus = useCallback(
    (query: string) => {
      const visibleCount = visibleEntries.filter((entry) =>
        matchesPaneFilterQuery(query, libraryEntryFilterFields(entry)),
      ).length;
      const unit = { singular: "entry", plural: "entries" };
      return entryCollectionComplete
        ? {
            kind: "Complete" as const,
            visibleCount,
            totalCount: visibleEntries.length,
            unit,
          }
        : {
            kind: "Partial" as const,
            visibleCount,
            loadedCount: visibleEntries.length,
            unit,
          };
    },
    [entryCollectionComplete, visibleEntries],
  );
  const { query: filterQuery, publication: search } = usePaneFilterRows({
    sourceKey: `Library.Entries:${id}`,
    inputLabel: "Filter library entries",
    placeholder: "Filter entries",
    getRowStatus: getFilterStatus,
    activeDomainControlCount,
    filters: domainFilterControls,
  });
  dismissFilterQueryRef.current = search.onDismiss;
  filterQueryRef.current = filterQuery;
  const filteredEntries = useMemo(
    () =>
      visibleEntries.filter((entry) =>
        matchesPaneFilterQuery(filterQuery, libraryEntryFilterFields(entry)),
      ),
    [filterQuery, visibleEntries],
  );
  const entryFolio = entryCollectionComplete
      ? {
          kind: "count" as const,
          value: visibleEntries.length,
          unit: "entry" as const,
        }
      : { kind: "none" as const };
  const connectionsComposerController = useConnectionsComposerController({
    scheme: "library",
    id,
  });
  const connectionsBody = useMemo(
    () => (
      <ConnectionsSurface
        resourceRef={{ scheme: "library", id }}
        composerController={connectionsComposerController}
        activateTarget={activateTarget}
      />
    ),
    [activateTarget, connectionsComposerController, id],
  );
  const membersBody = useMemo(
    () =>
      libraryMembersController ? (
        <LibraryMembersSurface controller={libraryMembersController} />
      ) : null,
    [libraryMembersController],
  );
  const publishMembers =
    currentLibrary?.canManageMembers === true &&
    currentLibrary.isDefault === false &&
    currentLibrary.systemKey === null &&
    membersBody !== null;
  const { companionAction } = useResourceInspector({
    scheme: "library",
    handle: currentLibrary ? id : null,
    bodies: {
      members: publishMembers ? membersBody : undefined,
      linkedItems: connectionsBody,
    },
  });
  const retryLibraryRefreshRef = useRef<() => void>(() => {});
  const retryLibraryRefresh = useCallback(() => {
    const controller = new AbortController();
    setError(null);
    void runPodcastRefresh(
      { kind: "Library", libraryId: id },
      { signal: controller.signal, onProgress: () => {} },
    )
      .then(async (result) => {
        await revalidateLibraryEntries(controller.signal);
        if (result.kind === "Complete") return;
        setError({
          content: {
            tone: result.kind === "Failed" ? "Danger" : "Warning",
            title: result.announcement,
          },
          actions: [
            { label: "Retry", onClick: () => retryLibraryRefreshRef.current() },
          ],
        });
      })
      .catch((refreshError: unknown) => {
        if (isAbortError(refreshError)) return;
        if (handleUnauthenticatedApiError(refreshError)) return;
        presentFailure(
          refreshError,
          "Library couldn’t be refreshed",
          "PodcastMutation",
          {
            label: "Retry",
            onClick: () => retryLibraryRefreshRef.current(),
          },
        );
      });
  }, [id, presentFailure, revalidateLibraryEntries]);
  retryLibraryRefreshRef.current = retryLibraryRefresh;
  const executeRefresh = useCallback<PaneRefreshPublication["execute"]>(
    async ({ signal, reportProgress }) => {
      try {
        const result = await runPodcastRefresh(
          { kind: "Library", libraryId: id },
          {
            signal,
            onProgress: ({ finishedCount, requestedCount }) =>
              reportProgress({
                kind: "Determinate",
                finishedCount,
                requestedCount,
              }),
          },
        );
        await revalidateLibraryEntries(signal);
        return {
          kind: result.kind,
          announcement: result.announcement,
        };
      } catch (refreshError: unknown) {
        if (isAbortError(refreshError)) throw refreshError;
        const content = libraryRequestErrorMessage(
          refreshError,
          {
            title: "Library couldn’t be refreshed",
            request: "PodcastMutation",
          },
        );
        setError({
          content,
          announcement: "None",
          actions: [
            {
              label: "Retry",
              onClick: () => retryLibraryRefreshRef.current(),
            },
          ],
        });
        return {
          kind: "Failed",
          announcement: content.title,
        };
      }
    },
    [id, revalidateLibraryEntries],
  );
  usePanePrimaryChrome({
    search,
    refresh:
      currentLibrary && requestedViewKey && viewIsCommitted
        ? {
            sourceKey: requestedViewKey,
            execute: executeRefresh,
          }
        : undefined,
    actions: companionAction ? [companionAction] : [],
    resourceTarget: currentLibrary
      ? routeResourceActionSubject({
          scheme: "library",
          id: currentLibrary.id,
          href: `/libraries/${currentLibrary.id}`,
        })
      : undefined,
    // "Add content" is a pane view control, ejected from the resource menu into
    // the pane's own dedicated menu (AC4).
    viewMenu:
      addContentAction.length > 0
        ? {
            label: "Add content",
            icon: <Plus size={16} aria-hidden="true" />,
            actions: addContentAction,
          }
        : undefined,
    header: {
      kind: "section",
      folio: entryFolio,
      pending: loading || !entryCollectionComplete,
    },
  });

  const visibleRowSignature = filteredEntries
    .map((entry) => libraryRowKey(entry, isDefaultLibrary))
    .join("");
  useEffect(() => {
    const neighborKey = pendingFocusNeighborRef.current;
    if (neighborKey === undefined) return;
    const moveFocus = () => {
      if (pendingFocusNeighborRef.current !== neighborKey) return;
      pendingFocusNeighborRef.current = undefined;
      const region = listRegionRef.current;
      const focusInRow = (key: string): boolean => {
        const rowEl = region?.querySelector<HTMLElement>(
          `[data-collection-row-id="${CSS.escape(key)}"]`,
        );
        const focusable = rowEl?.querySelector<HTMLElement>(
          'a, button, [tabindex]:not([tabindex="-1"])',
        );
        if (focusable) {
          focusable.focus();
          return true;
        }
        return false;
      };
      if (neighborKey !== null && focusInRow(neighborKey)) return;
      findPaneSearchFocusTarget(paneId)?.focus();
    };
    // Defer past the menu's own focus-restore and the row-removal reflow so the
    // sibling (not the vanished trigger) ends up focused.
    const outer = requestAnimationFrame(() => {
      const inner = requestAnimationFrame(moveFocus);
      pendingFocusRafRef.current = inner;
    });
    pendingFocusRafRef.current = outer;
    return () => cancelAnimationFrame(pendingFocusRafRef.current);
  }, [paneId, visibleRowSignature]);

  if (defect !== null) throw defect.error;

  const firstPageFailureContent =
    firstPageError === null
      ? null
      : isInvalidViewError(firstPageError)
        ? { tone: "Danger" as const, title: "Invalid library view" }
        : libraryRequestErrorMessage(
            firstPageError,
            {
              title: "Library entries couldn’t be loaded",
              request: "EntryRead",
            },
          );

  if (loading) {
    return (
      <>
        <PaneLoadingState label="Loading library…" announcement="Polite" />
        {filterQuery.trim() && filteredEntries.length === 0 ? (
          <FeedbackNotice
            content={{
              tone: "Neutral",
              title: "No matching entry found so far.",
            }}
            announcement="None"
          />
        ) : null}
      </>
    );
  }

  // Pre-metadata only: no committed page AND no route-resource metadata. Once
  // metadata is known (knownLibrary), the pane falls through to render its
  // toolbar plus the polite status node — even before the first page commits.
  if (!knownLibrary) {
    if (viewInvalid) {
      return (
        <FeedbackNotice
          content={{ tone: "Danger", title: "Invalid library view" }}
          announcement="Assertive"
          actions={[
            {
              label: "Reset view",
              onClick: () => {
                search.onDismiss();
                setDecodedView({
                  kind: "Valid",
                  view: CANONICAL_LIBRARY_VIEW,
                });
              },
            },
          ]}
        />
      );
    }
    if (failedFirstPage !== null) {
      return (
        <FeedbackNotice
          content={firstPageFailureContent!}
          announcement="Assertive"
          actions={[{ label: "Retry", onClick: failedFirstPage.retry }]}
        />
      );
    }
    return (
      <FeedbackNotice
        content={
          error?.content ?? { tone: "Danger", title: "Library not found" }
        }
        announcement="Assertive"
        actions={error?.actions}
      />
    );
  }

  const entryRegionId = `library-entry-region-${id}`;
  // Reorder exists only for a fully loaded editable non-default
  // Canonical + AllItems(All) list.
  const canReorderVisibleEntries =
    viewIsCommitted &&
    canReorder &&
    committedView?.order.kind === "Canonical" &&
    committedView.projection.kind === "AllItems" &&
    committedView.projection.completion === "all" &&
    committedView.entryType.kind === "AllTypes" &&
    controller?.entries.exhaustion === "Complete" &&
    entryExhaustion.kind === "Complete";
  const entryFooter = <CollectionExhaustionNotice state={entryExhaustion} />;
  const retryEntryReconciliation = entryReconciliationRequest
    ? () =>
        requestEntryReconciliation(
          entryReconciliationRequest.view,
          {
            placement: libraryPlacementSnapshot().revision,
            consumption: consumptionProjectionSnapshot().revision,
          },
          entryReconciliationRequest.recovery,
        )
    : null;
  const entryReconciliationNotice = entryReconciliationRequest ? (
    entryReconciliationFetch.error === null ? (
      <FeedbackNotice
        content={{ tone: "Neutral", title: "Refreshing library entries…" }}
        announcement="Polite"
      />
    ) : entryReconciliationRequest.recovery === "RefreshList" ? (
      <FeedbackNotice
        content={{ tone: "Warning", title: "List changed while loading" }}
        announcement="Assertive"
        actions={[
          {
            label: "Refresh list",
            onClick: retryEntryReconciliation!,
          },
        ]}
      />
    ) : (
      <FeedbackNotice
        content={libraryRequestErrorMessage(
          entryReconciliationFetch.error,
          {
            title: "Library entries couldn’t be refreshed",
            request: "EntryRead",
          },
        )}
        announcement="Assertive"
        actions={[
          {
            label: "Retry",
            onClick: retryEntryReconciliation!,
          },
        ]}
      />
    )
  ) : null;
  // The single polite status node lives OUTSIDE the busy collection and points
  // at it via aria-controls. Requested/committed labels are the one formatter.
  const requestedViewLabel =
    view === null ? "" : formatLibraryView(view, isDefaultLibrary);
  const committedViewLabel =
    committedView === null
      ? ""
      : formatLibraryView(committedView, isDefaultLibrary);
  // Metadata is known but no page has ever committed (a factual/projection deep
  // link, or a non-zero-revision mount): the same single status node carries the
  // initial "Loading {requested}." / "Could not load {requested}." (no committed
  // view to show), with the controls retained around it.
  const initialLoadFailed =
    entriesState?.kind === "InitialLoading" && failedFirstPage !== null;
  const entryStatusNode =
    !invalidView && entriesState?.kind === "Refreshing" ? (
      <div
        className={styles.entryViewStatus}
        role="status"
        aria-controls={entryRegionId}
      >
        <span>{`Loading ${requestedViewLabel}. Showing ${committedViewLabel}.`}</span>
      </div>
    ) : !invalidView && entriesState?.kind === "RefreshFailed" ? (
      <div
        className={styles.entryViewStatus}
        role="status"
        aria-controls={entryRegionId}
      >
        <span>{`Could not load ${requestedViewLabel}. Showing ${committedViewLabel}.`}</span>
        {failedFirstPage !== null ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              pendingCommitFocusRef.current = "View";
              failedFirstPage.retry();
            }}
          >
            Retry
          </Button>
        ) : null}
      </div>
    ) : !invalidView && initialLoadFailed ? (
      <div
        className={styles.entryViewStatus}
        role="status"
        aria-controls={entryRegionId}
      >
        <span>{`Could not load ${requestedViewLabel}.`}</span>
        {failedFirstPage !== null ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              pendingCommitFocusRef.current = "View";
              failedFirstPage.retry();
            }}
          >
            Retry
          </Button>
        ) : null}
      </div>
    ) : !invalidView && entriesState?.kind === "InitialLoading" ? (
      <div
        className={styles.entryViewStatus}
        role="status"
        aria-controls={entryRegionId}
      >
        <span>{`Loading ${requestedViewLabel}.`}</span>
      </div>
    ) : null;

  const addedContext = (entry: LibraryEntry): Presence<CollectionContext> => {
    const iso = entry.addedAt;
    const label = isDefaultLibrary ? "Added to Nexus " : "Added ";
    return present({ kind: "Text", text: `${label}${formatAdded(iso)}` });
  };

  const entryRowView = (item: LibraryEntry): CollectionRowView => {
    const showAdded = committedView?.order.kind === "Added";
    if (item.kind === "podcast") {
      const subscription =
        item.subscription.kind === "Present"
          ? item.subscription.value
          : null;
      const row = presentPodcast(
        {
          id: item.podcast.id,
          title: item.podcast.title,
          contributors: item.podcast.contributors,
          unplayedCount: item.podcast.unplayedCount,
          publicationDate: item.podcast.publicationDate,
          syncStatus: item.podcast.syncStatus,
        },
        {
          settings:
            viewIsCommitted && subscription !== null
              ? {
                  kind: "Available",
                  execute: () =>
                    resourceOverlays.openPodcastSettings(item.podcast.id),
                }
              : { kind: "Unavailable" },
          checkForNewEpisodes:
            viewIsCommitted && subscription !== null
              ? {
                  kind: "Available",
                  execute: () => handleRefreshPodcast(item),
                }
              : { kind: "Unavailable" },
          subscription:
            viewIsCommitted && subscription !== null
              ? {
                  kind: "Subscribed",
                  execute: () => handleUnsubscribePodcast(item),
                }
              : { kind: "Unavailable" },
          busyIds: new Set<ResourceActionId>([
            ...(refreshingPodcastIds.ids.has(item.podcast.id)
              ? [RESOURCE_ACTION_CATALOG.RefreshPodcast.id]
              : []),
            ...(unsubscribingPodcastIds.ids.has(item.podcast.id)
              ? [RESOURCE_ACTION_CATALOG.UnsubscribePodcast.id]
              : []),
          ]),
        },
      );
      return {
        ...row,
        id: libraryRowKey(item, isDefaultLibrary),
        context: showAdded ? addedContext(item) : row.context,
      };
    }
    const lecternItem =
      lectern.resource.status === "ready"
        ? (lectern.resource.data.items.find(
            (candidate) => candidate.mediaId === item.media.id,
          ) ?? null)
        : null;
    const row = presentMedia(item.media, {
      readingTimeEstimate: item.readingTimeEstimate,
      retryProcessing:
        viewIsCommitted && item.media.capabilities.can_retry
          ? {
              kind: "Available",
              execute: () => handleRetryProcessing(item.media.id),
            }
          : { kind: "Unavailable" },
      refreshSource:
        viewIsCommitted && item.media.capabilities.can_refresh_source
          ? {
              kind: "Available",
              execute: () => handleRefreshSource(item.media.id),
            }
          : { kind: "Unavailable" },
      retryMetadata:
        viewIsCommitted && item.media.capabilities.can_retry_metadata
          ? {
              kind: "Available",
              execute: () => handleRetryMetadata(item.media.id),
            }
          : { kind: "Unavailable" },
      editAuthors:
        viewIsCommitted && item.media.capabilities.can_edit_authors
          ? {
              kind: "Available",
              execute: (detail) =>
                openAuthorsEditor(
                  item.media.id,
                  libraryRowKey(item, isDefaultLibrary),
                  detail,
                ),
            }
          : { kind: "Unavailable" },
      removeMedia:
        viewIsCommitted && item.media.capabilities.can_delete
          ? {
              kind: "Available",
              execute: () => handleDeleteMedia(item),
            }
          : { kind: "Unavailable" },
      progressReset:
        viewIsCommitted &&
        item.media.progress_resettable &&
        !updatingConsumptionMediaIds.has(item.media.id)
          ? {
              kind: "Available",
              execute: () => {
                return handleResetProgress(
                  item.media.id,
                  item.media.kind === "video",
                  isInProgressView
                    ? libraryRowKey(item, isDefaultLibrary)
                    : null,
                );
              },
            }
          : { kind: "Unavailable" },
      readState: !viewIsCommitted
        ? { kind: "Unavailable" }
        : item.media.read_state === "finished"
          ? {
              kind: "MarkUnread",
              execute: () => {
                // Mark Unread drops the row from an In Progress view.
                if (isInProgressView) {
                  captureFocusNeighbor(libraryRowKey(item, isDefaultLibrary));
                }
                return handleSetConsumption(item.media.id, "unread");
              },
            }
          : {
              kind: "MarkFinished",
              execute: () => {
                // Mark Finished drops the row under the unfinished filter OR from
                // an In Progress view.
                if (hideFinished || isInProgressView) {
                  captureFocusNeighbor(libraryRowKey(item, isDefaultLibrary));
                }
                return handleSetConsumption(item.media.id, "finished");
              },
            },
      lecternMembership:
        !viewIsCommitted || lectern.resource.status !== "ready"
          ? { kind: "Unavailable" }
          : lecternItem
            ? {
                kind: "Remove",
                itemId: lecternItem.itemId,
                execute: () =>
                  handleRemoveFromLectern(item.media.id, lecternItem.itemId),
              }
            : {
                kind: "Add",
                execute: () => handleAddToLectern(item.media.id),
              },
      busyIds: new Set<ResourceActionId>([
        ...(retryingMediaIds.ids.has(item.media.id)
          ? [RESOURCE_ACTION_CATALOG.RetryProcessing.id]
          : []),
        ...(refreshingMediaIds.ids.has(item.media.id)
          ? [RESOURCE_ACTION_CATALOG.RefreshSource.id]
          : []),
        ...(retryingMetadataMediaIds.ids.has(item.media.id)
          ? [RESOURCE_ACTION_CATALOG.RetryMetadata.id]
          : []),
        ...(deletingMediaIds.ids.has(item.media.id)
          ? [RESOURCE_ACTION_CATALOG.RemoveMedia.id]
          : []),
        ...(updatingConsumptionMediaIds.ids.has(item.media.id)
          ? [
              RESOURCE_ACTION_CATALOG.MarkFinished.id,
              RESOURCE_ACTION_CATALOG.MarkUnread.id,
            ]
          : []),
        ...(resettingProgressMediaIds.ids.has(item.media.id)
          ? [RESOURCE_ACTION_CATALOG.ResetProgress.id]
          : []),
        ...(addingToLecternMediaIds.ids.has(item.media.id)
          ? [RESOURCE_ACTION_CATALOG.AddToLectern.id]
          : []),
        ...(removingFromLecternMediaIds.ids.has(item.media.id)
          ? [RESOURCE_ACTION_CATALOG.RemoveFromLectern.id]
          : []),
      ]),
    });
    return {
      ...row,
      id: libraryRowKey(item, isDefaultLibrary),
      context: showAdded ? addedContext(item) : row.context,
    };
  };
  const visibleEntryRows = filteredEntries.map(entryRowView);

  const entriesAccessibleName = libraryPresentation(knownLibrary).name;
  // Both recoveries request AllItems(All) preserving order and focus View; the
  // completion-only "Show finished" recovery focuses the Hide-finished checkbox.
  const recoverToAllItems = () => {
    if (committedView === null) return;
    pendingCommitFocusRef.current = "View";
    setView({
      order: committedView.order,
      projection: { kind: "AllItems", completion: "all" },
      entryType: committedView.entryType,
    });
  };
  const recoverShowFinished = () => {
    if (committedView === null) return;
    pendingCommitFocusRef.current = "HideFinished";
    setView(withCompletion(committedView, "all"));
  };
  // Closed-union empty-state precedence (never inferred from counts).
  const emptyStateNotice = (() => {
    const exactEntryType =
      committedView?.entryType.kind === "ExactType"
        ? committedView.entryType.value
        : null;
    const projection =
      committedView?.projection ?? CANONICAL_LIBRARY_VIEW.projection;
    if (exactEntryType !== null) {
      return (
        <FeedbackNotice
          content={{
            tone: "Neutral",
            title: `No matches for “${entryTypeOptionLabel(exactEntryType)}” in this view.`,
          }}
          announcement="Polite"
          actions={[{ label: "Clear filters", onClick: clearDomainFilters }]}
        />
      );
    }
    if (projection.kind === "InProgress") {
      return (
        <FeedbackNotice
          content={{ tone: "Neutral", title: "Nothing in progress." }}
          announcement="Polite"
          actions={[{ label: "Show all items", onClick: recoverToAllItems }]}
        />
      );
    }
    if (projection.kind === "Unfiled") {
      return projection.completion === "all" ? (
        <FeedbackNotice
          content={{ tone: "Neutral", title: "Everything is filed." }}
          announcement="Polite"
          actions={[{ label: "Show all items", onClick: recoverToAllItems }]}
        />
      ) : (
        <FeedbackNotice
          content={{
            tone: "Neutral",
            title: "No unfinished unfiled items.",
          }}
          announcement="Polite"
          actions={[{ label: "Clear filters", onClick: clearDomainFilters }]}
        />
      );
    }
    return projection.completion === "all" ? (
      <FeedbackNotice
        content={{
          tone: "Neutral",
          title: isDefaultLibrary
            ? "No media yet."
            : "No podcasts or media in this library yet.",
        }}
        announcement="Polite"
      />
    ) : (
      <FeedbackNotice
        content={{ tone: "Neutral", title: "No unfinished items." }}
        announcement="Polite"
        actions={[{ label: "Show finished", onClick: recoverShowFinished }]}
      />
    );
  })();
  const mainBody = invalidView ? (
    <FeedbackNotice
      content={{ tone: "Danger", title: "Invalid library view" }}
      announcement="Assertive"
      actions={[
        {
          label: "Reset view",
          onClick: () => {
            search.onDismiss();
            setDecodedView({ kind: "Valid", view: CANONICAL_LIBRARY_VIEW });
          },
        },
      ]}
    />
  ) : filteredEntries.length > 0 ? (
    <CollectionView
      returnScope="Library.Entries"
      rows={visibleEntryRows}
      status="ready"
      ariaLabel={entriesAccessibleName}
      rowChangePresentation={{
        kind: "ImmediateOnKeyChange",
        key: filterQuery.trim(),
      }}
      rowActionsAvailable={viewIsCommitted}
      footer={entryFooter}
      collectionBusy={entryExhaustion.kind === "Draining"}
      surface={false}
      sortable={
        canReorderVisibleEntries && !filterQuery.trim()
          ? {
              disabled: reorderBusy,
              onReorder: (nextRows) => {
                const byEntryId = new Map(
                  filteredEntries.map((entry) => [
                    libraryRowKey(entry, isDefaultLibrary),
                    entry,
                  ]),
                );
                const nextEntries = nextRows
                  .map((row) => byEntryId.get(row.id))
                  .filter(
                    (entry): entry is LibraryEntry => entry !== undefined,
                  );
                if (nextEntries.length === filteredEntries.length) {
                  handleReorderEntries(nextEntries);
                }
              },
            }
          : undefined
      }
    />
  ) : filterQuery.trim() ? (
    entryCollectionComplete ? (
      <FeedbackNotice
        content={{
          tone: "Neutral",
          title: "No entries match this filter.",
        }}
        announcement="Polite"
      />
    ) : (
      <>
        <FeedbackNotice
          content={{
            tone: "Neutral",
            title: "No matching entry found so far.",
          }}
          announcement="Polite"
        />
        {entryFooter}
      </>
    )
  ) : currentLibrary ===
    null ? // (rows/empty-state only); the polite status node carries "Loading …" / // Metadata known but no page has committed yet: the busy region stays empty
  // "Could not load …". No false empty-state notice before the first commit.
  null : entryExhaustion.kind !== "Complete" ? (
    entryFooter
  ) : (
    emptyStateNotice
  );

  return (
    <>
      <PaneSurface
        opener={<SectionOpener heading={entriesAccessibleName} scale="title" />}
        state={
          error || authorityFeedback || entryReconciliationNotice ? (
            <>
              {error ? (
                <FeedbackNotice
                  content={error.content}
                  announcement={error.announcement ?? "Assertive"}
                  actions={error.actions}
                />
              ) : null}
              {authorityFeedback ? (
                <FeedbackNotice
                  content={authorityFeedback}
                  announcement="Assertive"
                />
              ) : null}
              {entryReconciliationNotice}
            </>
          ) : null
        }
      >
        {entryStatusNode}
        <div
          id={entryRegionId}
          ref={listRegionRef}
          role="region"
          aria-label={entriesAccessibleName}
          aria-busy={
            entriesState?.kind === "Refreshing" ||
            (entriesState?.kind === "InitialLoading" &&
              !invalidView &&
              failedFirstPage === null) ||
            entryExhaustion.kind === "Draining"
              ? true
              : undefined
          }
        >
          {mainBody}
        </div>
        {currentLibrary !== null &&
        controller?.entries.exhaustion === "Complete" &&
        entryExhaustion.kind === "Complete" ? (
          <ReadingSlateSection
            returnScope="Library.ReadingSlate"
            destination={{
              kind: "Library",
              id: currentLibrary.id,
              name: libraryPresentation(currentLibrary).name,
            }}
            paneId={paneId}
            isActive={isPaneActive}
            accept={acceptSlateTarget}
          />
        ) : null}
      </PaneSurface>

      {authorsEditorMounted && authorsEditorMedia ? (
        <Suspense fallback={null}>
          <MediaAuthorsEditor
            mediaId={authorsEditorMedia.id}
            open={authorsEditorOpen}
            authors={mapMediaAuthorCredits(authorsEditorMedia.contributors)}
            authorMode={authorsEditorMedia.author_mode}
            returnFocusTo={() => authorsEditorTrigger}
            returnFocusFallback={() => sortSelectRef.current}
            onClose={() => setAuthorsEditorOpen(false)}
            onSaved={handleAuthorsSaved}
          />
        </Suspense>
      ) : null}
    </>
  );
}
