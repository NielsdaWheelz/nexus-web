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
import { dispatchOpenLauncher } from "@/lib/launcher/launcherEvents";
import {
  ApiError,
  apiFetch,
  isApiError,
  isSameSystemApiDefect,
} from "@/lib/api/client";
import { present, type Presence } from "@/lib/api/presence";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  libraryEntriesResource,
  libraryResource as libraryResourceDescriptor,
  type LibraryEntriesResourceParams,
} from "@/lib/api/resource";
import { runSourceProcessingAction } from "@/lib/media/sourceActions";
import {
  retryMediaMetadata,
  type MediaActionCapabilities,
} from "@/lib/media/ingestionClient";
import type { DocumentProcessingStatus } from "@/lib/media/documentReadiness";
import {
  FeedbackNotice,
  toFeedback,
  useFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import ConnectionsSurface from "@/components/connections/ConnectionsSurface";
import { useConnectionsComposerController } from "@/components/connections/connectionsComposerController";
import {
  RESOURCE_ACTION_CATALOG,
  libraryResourceOptions,
  type ResourceActionId,
} from "@/lib/actions/resourceActions";
import { useLectern } from "@/lib/lectern/LecternProvider";
import { useCompletionUndo } from "@/lib/lectern/useCompletionUndo";
import { parseMediaId, type LecternItemId } from "@/lib/lectern/contract";
import { runProgressReset } from "@/lib/consumption/progressReset";
import { presentMedia } from "@/lib/collections/presenters/media";
import { presentPodcast } from "@/lib/collections/presenters/podcast";
import LoadMoreFooter from "@/components/ui/LoadMoreFooter";
import { confirmAndDeleteMedia } from "@/lib/media/mediaLibraries";
import {
  addLibraryPlacement,
  listLibraryPlacements,
} from "@/lib/libraries/libraryPlacement";
import { useStringIdSet, type StringIdSet } from "@/lib/useStringIdSet";
import { clientResourceFetcher } from "@/lib/api/resourceTransport.client";
import { useResource } from "@/lib/api/useResource";
import { paneResourceLoaders } from "@/lib/panes/paneResourceLoaders";
import {
  buildPodcastUnsubscribeConfirmation,
  refreshPodcastSubscriptionSync,
  unsubscribeFromPodcast,
  type PodcastSubscriptionSettingsResponse,
} from "@/app/(authenticated)/podcasts/podcastSubscriptions";
import PodcastSubscriptionSettingsModal from "@/app/(authenticated)/podcasts/PodcastSubscriptionSettingsModal";
import { usePodcastSubscriptionSettingsModal } from "@/app/(authenticated)/podcasts/usePodcastSubscriptionSettingsModal";
import Button from "@/components/ui/Button";
import Select from "@/components/ui/Select";
import Toggle from "@/components/ui/Toggle";
import PaneSurface from "@/components/ui/PaneSurface";
import SectionOpener from "@/components/ui/SectionOpener";
import CollectionView from "@/components/collections/CollectionView";
import ReadingSlateSection from "@/components/collections/ReadingSlateSection";
import PaneToolbar from "@/components/ui/PaneToolbar";
import type {
  CollectionContext,
  CollectionRowView,
} from "@/lib/collections/types";
import type {
  PositiveCount,
  ProgressFraction,
} from "@/lib/consumption/activityFacts";
import type { PublicationDate } from "@/lib/dates/publicationDate";
import {
  decodePodcastSyncStatus,
  type PodcastSyncStatus,
} from "@/lib/status/podcastSync";
import { useConnectionSummaries } from "@/lib/collections/useConnectionSummaries";
import { useDebouncedFetch } from "@/lib/api/useDebouncedFetch";
import LibrarySettingsDialog from "@/components/LibrarySettingsDialog";
import LibraryMembersSurface from "@/components/libraries/LibraryMembersSurface";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import { useResourceInspector } from "@/lib/dossiers/useResourceInspector";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import {
  definePaneVisitDataKey,
  useClearAllPaneVisitData,
  usePaneParam,
  usePaneReturnReady,
  usePaneRouter,
  usePaneRuntime,
  requirePaneRuntime,
  usePaneVisitData,
  useSetPaneLabel,
} from "@/lib/panes/paneRuntime";
import type { LibraryOut } from "@/lib/libraries/contract";
import { useLibraryMembers } from "@/lib/libraries/useLibraryMembers";
import { usePaneUrlState } from "@/lib/api/usePaneUrlState";
import {
  completionOf,
  decodeLibraryView,
  encodeLibraryView,
  formatLibraryView,
  orderPresetIdsFor,
  orderToPresetId,
  presetIdToOrder,
  presetLabel,
  projectionOptionLabel,
  projectionOptionOf,
  projectionOptionsFor,
  projectionSupportsCompletion,
  withCompletion,
  withProjectionOption,
  type DecodedLibraryView,
  type LibraryEntryView,
  type LibraryOrderPresetId,
  type ProjectionOptionId,
} from "@/lib/libraries/libraryView";
import { libraryPresentation } from "@/lib/libraries/presentation";
import {
  libraryPlacementAffectedSince,
  publishLibraryPlacementChange,
  useLibraryPlacementRevision,
} from "@/lib/libraries/placementRevision";
import { useConsumptionProjectionRevision } from "@/lib/consumption/projectionRevision";
import type { ContributorCredit, MediaAuthors } from "@/lib/contributors/types";
import type {
  ActionDescriptor,
  ActionSelectDetail,
} from "@/lib/ui/actionDescriptor";
import { routeResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import { isAbortError } from "@/lib/errors";
import { mapMediaAuthorCredits } from "@/app/(authenticated)/media/[id]/mediaFormatting";
import {
  decodeLibraryReadingTimeEntry,
  type LibraryMediaKind,
  type ReadingTimeEstimatePresence,
} from "@/lib/libraries/readingTime";
import { slateTargetId } from "@/lib/resonance/contract";
import type { ReadingSlateAccept } from "@/lib/resonance/useReadingSlate";
import styles from "./LibraryPaneBody.module.css";

const MediaAuthorsEditor = lazy(
  () =>
    import(/* @vite-ignore */ "@/components/contributors/MediaAuthorsEditor"),
);

type Library = LibraryOut;

interface LibraryMediaEntry {
  id: string;
  kind: LibraryMediaKind;
  title: string;
  // Instant the underlying media entered Nexus. Drives the "Added to Nexus …"
  // row line under the Added order for the default (virtual) library, where each
  // row keys by media rather than by physical library entry.
  created_at: string;
  contributors: ContributorCredit[];
  author_mode: "automatic" | "manual";
  published_date: string | null;
  publicationDate: Presence<PublicationDate>;
  publisher: string | null;
  canonical_source_url: string | null;
  sourceHost: Presence<string>;
  processing_status: DocumentProcessingStatus;
  read_state: "unread" | "in_progress" | "finished";
  progress_fraction: number | null;
  progressFraction: Presence<ProgressFraction>;
  progress_resettable: boolean;
  last_engaged_at?: string | null;
  capabilities: Partial<MediaActionCapabilities> &
    Pick<MediaActionCapabilities, "can_quote">;
}

type LibraryMediaConsumption = Pick<
  LibraryMediaEntry,
  "read_state" | "progress_fraction"
>;

interface LibraryPodcastEntry {
  id: string;
  title: string;
  contributors: ContributorCredit[];
  feed_url: string;
  website_url: string | null;
  image_url: string | null;
  unplayed_count: number;
  unplayedCount: Presence<PositiveCount>;
  publicationDate: Presence<PublicationDate>;
  syncStatus: Presence<PodcastSyncStatus>;
}

interface LibraryPodcastSubscription {
  status: "active" | "unsubscribed";
  default_playback_speed: number | null;
  auto_queue: boolean;
  sync_status:
    | "pending"
    | "running"
    | "partial"
    | "complete"
    | "source_limited"
    | "failed";
}

interface LibraryEntryBase {
  id: string;
  position: number;
  created_at: string;
  readingTimeEstimate: ReadingTimeEstimatePresence;
}

interface LibraryMediaListEntry extends LibraryEntryBase {
  kind: "media";
  media: LibraryMediaEntry;
}

interface LibraryPodcastListEntry extends LibraryEntryBase {
  kind: "podcast";
  podcast: LibraryPodcastEntry;
  subscription: LibraryPodcastSubscription | null;
}

type LibraryEntry = LibraryMediaListEntry | LibraryPodcastListEntry;

type LibraryMediaEntryWire = Omit<
  LibraryMediaEntry,
  "progressFraction" | "publicationDate" | "sourceHost"
>;
type LibraryPodcastEntryWire = Omit<
  LibraryPodcastEntry,
  "unplayedCount" | "publicationDate" | "syncStatus"
>;
type LibraryEntryWire =
  | (Omit<LibraryMediaListEntry, "media" | "readingTimeEstimate"> & {
      media: LibraryMediaEntryWire;
      readingTimeEstimate: unknown;
    })
  | (Omit<LibraryPodcastListEntry, "podcast" | "readingTimeEstimate"> & {
      podcast: LibraryPodcastEntryWire;
      readingTimeEstimate: unknown;
    });

interface LibraryPageInfo {
  has_more: boolean;
  next_cursor: string | null;
}

interface LibraryEntryPage {
  data: LibraryEntry[];
  page: LibraryPageInfo;
}

interface LibraryEntryPageWire {
  data: LibraryEntryWire[];
  page: LibraryPageInfo;
}

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
  // The revisions captured when this reconciliation was requested. On commit
  // they become the committed baseline, so a mutation that landed while the
  // reconciliation was in flight surfaces as exactly one coalesced follow-up.
  revisions: LibraryRevisions;
}

interface EntryReconciliationResult {
  request: EntryReconciliationRequest;
  page: LibraryEntryPage;
}

interface LibraryEntryPageResult {
  requestKey: string;
  requestedViewKey: string;
  view: LibraryEntryView;
  page: LibraryEntryPage;
  revisions: LibraryRevisions;
}

function decodeLibraryEntryPage(page: LibraryEntryPageWire): LibraryEntryPage {
  return {
    ...page,
    data: page.data.map(decodeLibraryReadingTimeEntry),
  };
}

interface LibraryPaneResource {
  library: Library;
  entries: LibraryEntry[];
  entriesPage: LibraryPageInfo;
}

interface CommittedLibraryView {
  readonly view: LibraryEntryView;
  readonly entries: readonly LibraryEntry[];
  readonly nextCursor: string | null;
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

// The default library's read surface is a deduplicated virtual set: the server
// can hand back a different representative entry id for the same underlying
// media across paginated fetches, so Default rows/merges key by `media.id`.
// Non-default libraries key by the physical entry id, unchanged.
function libraryRowKey(entry: LibraryEntry, isDefaultLibrary: boolean): string {
  return isDefaultLibrary && entry.kind === "media" ? entry.media.id : entry.id;
}

function appendUniqueEntries(
  current: LibraryEntry[],
  next: LibraryEntry[],
  keyOf: (entry: LibraryEntry) => string = (entry) => entry.id,
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

function toLibraryAddError(error: unknown): ApiError {
  return isApiError(error)
    ? error
    : new ApiError(
        0,
        "E_NETWORK",
        error instanceof Error ? error.message : "Request failed",
      );
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

// A canonical/all view is exactly the server's default order that the bootstrap
// `libraryResource` already seeded; any factual order, projection, or unfinished
// filter is a different first page fetched from the entries endpoint.
function isInitialLibraryView(view: LibraryEntryView): boolean {
  return (
    view.order.kind === "Canonical" &&
    view.projection.kind === "AllItems" &&
    view.projection.completion === "all"
  );
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

const CANONICAL_VIEW: LibraryEntryView = {
  order: { kind: "Canonical" },
  projection: { kind: "AllItems", completion: "all" },
};

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
  const isPaneActive = paneRuntime?.isActive ?? true;
  const paneId = paneRuntime?.paneId ?? `library-${id}`;
  const feedback = useFeedback();
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
  const reorderGenerationRef = useRef(0);
  const setView = useCallback(
    (next: LibraryEntryView) => {
      committedViewInvalidatedRef.current = true;
      committedSnapshotRef.current = null;
      reorderGenerationRef.current += 1;
      setDecodedView({ kind: "Valid", view: next });
    },
    [setDecodedView],
  );

  const captureCommitted = useCallback(() => committedSnapshotRef.current, []);
  const restored = usePaneVisitData(LIBRARY_VISIT_DATA, captureCommitted);
  const initialRestored = useRef(restored).current;
  const [controller, setController] = useState<LibrarySnapshot | null>(
    initialRestored,
  );
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
  const entryCursor = controller?.entries.nextCursor ?? null;
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
  const setEntryCursor: Dispatch<SetStateAction<string | null>> = useCallback(
    (update) => {
      setController((current) => {
        if (current === null) return current;
        const nextCursor =
          typeof update === "function"
            ? update(current.entries.nextCursor)
            : update;
        return {
          ...current,
          entries: { ...current.entries, nextCursor },
        };
      });
    },
    [],
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<FeedbackContent | null>(
    null,
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
  const unsubscribingPodcastIds = useStringIdSet();
  const [error, setError] = useState<FeedbackContent | null>(null);
  const [reorderBusy, setReorderBusy] = useState(false);
  // A stale/deployment-era continuation cursor: Load More is never reinterpreted
  // as an invalid view. Instead the list can no longer continue and offers
  // Refresh list, which discards the cursor and reloads the same view's first page.
  const [loadMoreCursorInvalid, setLoadMoreCursorInvalid] = useState(false);
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
  const [entryReconciliationRequest, setEntryReconciliationRequest] =
    useState<EntryReconciliationRequest | null>(null);
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
                  auto_queue: response.auto_queue,
                },
              }
            : candidate,
        ),
      );
      clearAllVisitData();
    },
    [clearAllVisitData, setEntries],
  );
  const podcastSettingsModal = usePodcastSubscriptionSettingsModal({
    onSaved: handlePodcastSettingsSaved,
  });
  const [authorsEditorMounted, setAuthorsEditorMounted] = useState(false);
  const [authorsEditorOpen, setAuthorsEditorOpen] = useState(false);
  const [authorsEditorMediaId, setAuthorsEditorMediaId] = useState<
    string | null
  >(null);
  const [authorsEditorTrigger, setAuthorsEditorTrigger] =
    useState<HTMLButtonElement | null>(null);
  const authorsEditorMedia =
    entries.find(
      (entry): entry is LibraryMediaListEntry =>
        entry.kind === "media" && entry.media.id === authorsEditorMediaId,
    )?.media ?? null;
  const openAuthorsEditor = useCallback(
    (mediaId: string, { triggerEl }: ActionSelectDetail) => {
      setAuthorsEditorMediaId(mediaId);
      setAuthorsEditorTrigger(triggerEl);
      setAuthorsEditorMounted(true);
      setAuthorsEditorOpen(true);
    },
    [],
  );
  // Focus continuity: when an action removes the focused row, move focus to the
  // next visible row, else the previous, else the "View" select, then "Sort by".
  const listRegionRef = useRef<HTMLDivElement | null>(null);
  const viewSelectRef = useRef<HTMLSelectElement | null>(null);
  const sortSelectRef = useRef<HTMLSelectElement | null>(null);
  const hideFinishedInputId = `library-hide-finished-${id}`;
  // A control to focus once the view/reconciliation it initiated commits. A
  // recovery action (Show all items, Clear filters, Show finished, Retry,
  // Refresh list) sets it; the matching commit applies and clears it.
  const pendingCommitFocusRef = useRef<"View" | "HideFinished" | null>(null);
  const focusPendingControl = useCallback(() => {
    const target = pendingCommitFocusRef.current;
    if (target === null) return;
    pendingCommitFocusRef.current = null;
    const element =
      target === "View"
        ? viewSelectRef.current
        : document.getElementById(hideFinishedInputId);
    if (element instanceof HTMLElement) {
      requestAnimationFrame(() => element.focus());
    }
  }, [hideFinishedInputId]);
  const pendingFocusNeighborRef = useRef<string | null | undefined>(undefined);
  const pendingFocusRafRef = useRef(0);
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
      patchMediaInViews(authorsEditorMediaId, (media) => {
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
        return {
          ...media,
          contributors: [
            ...authorCredits,
            ...media.contributors.filter((credit) => credit.role !== "author"),
          ],
          author_mode: result.authorMode,
        };
      });
      setAuthorsEditorOpen(false);
      clearAllVisitData();
    },
    [authorsEditorMediaId, clearAllVisitData, patchMediaInViews],
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
      feedback.show({
        severity: "warning",
        title: message,
      }),
    [feedback],
  );
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
  const connectionSummaries = useConnectionSummaries(
    entries.map((entry) =>
      entry.kind === "podcast"
        ? `podcast:${entry.podcast.id}`
        : `media:${entry.media.id}`,
    ),
  );

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
      let page: LibraryEntryPageWire;
      try {
        page = await apiFetch<LibraryEntryPageWire>(path, { signal });
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

  const [settingsOpen, setSettingsOpen] = useState(false);
  const deletingLibraryRef = useRef(false);
  const [deletingLibrary, setDeletingLibrary] = useState(false);

  const entryLoadMoreAbortRef = useRef<AbortController | null>(null);
  const entryLoadMoreGenerationRef = useRef(0);
  const cancelEntryLoadMore = useCallback(() => {
    entryLoadMoreGenerationRef.current += 1;
    entryLoadMoreAbortRef.current?.abort();
    entryLoadMoreAbortRef.current = null;
    setLoadingMore(false);
  }, []);
  useEffect(() => () => entryLoadMoreAbortRef.current?.abort(), []);
  useEffect(() => {
    cancelEntryLoadMore();
    consumptionOperationTokensRef.current.clear();
  }, [cancelEntryLoadMore, id]);

  const { clear: clearRemovedEntryIds } = removedEntryIds;
  const requestEntryReconciliation = useCallback(
    (requestedView: LibraryEntryView, revisions: LibraryRevisions) => {
      cancelEntryLoadMore();
      committedSnapshotRef.current = null;
      clearAllVisitData();
      const serial = entryReconciliationSerialRef.current + 1;
      entryReconciliationSerialRef.current = serial;
      setEntryReconciliationRequest({
        ownerId: id,
        view: requestedView,
        serial,
        revisions,
      });
    },
    [cancelEntryLoadMore, clearAllVisitData, id],
  );
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
        page: decodeLibraryEntryPage(
          await apiFetch<LibraryEntryPageWire>(path, { signal }),
        ),
      };
    },
    { debounceMs: 0 },
  );

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
              entries: result.page.data,
              nextCursor: result.page.page.next_cursor,
              revisions: result.request.revisions,
            },
          },
    );
    // The committed baseline advances to the revisions captured when this
    // reconciliation was requested, so a mutation that landed while it was in
    // flight surfaces as exactly one coalesced follow-up.
    committedRevisionsRef.current = result.request.revisions;
    setLoadMoreCursorInvalid(false);
    setLoadMoreError(null);
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
    entryReconciliationRequest,
    isPaneActive,
    placementChange.revision,
    requestEntryReconciliation,
    revisionsAreStale,
    viewIsCommitted,
  ]);

  useEffect(() => {
    entryReconciliationSerialRef.current += 1;
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
            view: view ?? CANONICAL_VIEW,
            entries: libraryResource.data.entries,
            nextCursor: libraryResource.data.entriesPage.next_cursor,
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
      setError(
        toFeedback(libraryResource.error, {
          fallback: "Failed to load library",
        }),
      );
      setController(null);
      setLoadMoreError(null);
    }
  }, [
    bootstrapSeedClaimable,
    cancelEntryLoadMore,
    id,
    isInitialView,
    libraryResource,
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
    setLoadMoreError(null);
    setLoadMoreCursorInvalid(false);
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
        entries: firstPageResource.data.page.data,
        nextCursor: firstPageResource.data.page.page.next_cursor,
        revisions: committedRevisions,
      },
    });
    setLoadMoreError(null);
    setLoadMoreCursorInvalid(false);
    setViewInvalid(false);
    const scrollport = listRegionRef.current?.closest<HTMLElement>(
      "[data-pane-content]",
    );
    if (scrollport) scrollport.scrollTop = 0;
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

  const firstPageDefect =
    firstPageError !== null && isSameSystemApiDefect(firstPageError)
      ? firstPageError
      : null;
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
      const frozenAttempt = () =>
        addLibraryPlacement({ kind: target.kind, id: targetId }, id);

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
              // revision store; the revision-driven trigger reconciles the
              // current view. No explicit reconciliation call here.
              feedback.show({
                severity: "success",
                title: `Added to ${
                  currentLibrary
                    ? libraryPresentation(currentLibrary).name
                    : "library"
                }`,
              });
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
              const apiError = toLibraryAddError(error);
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
    [committedView, currentLibrary, feedback, id, viewIsCommitted],
  );

  const runMediaProcessingMutation = useCallback(
    async (args: {
      mediaId: string;
      busySet: StringIdSet;
      action: "retry" | "refresh";
      successTitle: string;
      errorFallback: string;
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
        feedback.show(projection.feedback);
        clearAllVisitData();
      } catch (err) {
        if (handleUnauthenticatedApiError(err)) return;
        if (!isApiError(err) || isSameSystemApiDefect(err)) throw err;
        feedback.show({
          ...toFeedback(err, { fallback: args.errorFallback }),
        });
      } finally {
        args.busySet.remove(args.mediaId);
      }
    },
    [clearAllVisitData, feedback, patchMediaInViews],
  );

  const handleRetryProcessing = useCallback(
    (mediaId: string) =>
      runMediaProcessingMutation({
        mediaId,
        busySet: retryingMediaIds,
        action: "retry",
        successTitle: "Processing retry started.",
        errorFallback: "Failed to retry processing",
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
        errorFallback: "Failed to refresh source",
      }),
    [refreshingMediaIds, runMediaProcessingMutation],
  );

  const handleRetryMetadata = useCallback(
    async (mediaId: string) => {
      if (retryingMetadataMediaIds.has(mediaId)) return;
      retryingMetadataMediaIds.add(mediaId);
      try {
        await retryMediaMetadata(mediaId);
        feedback.show({
          severity: "success",
          title: "Metadata re-enrichment started.",
        });
        clearAllVisitData();
      } catch (metadataError) {
        if (handleUnauthenticatedApiError(metadataError)) return;
        if (
          !isApiError(metadataError) ||
          isSameSystemApiDefect(metadataError)
        ) {
          throw metadataError;
        }
        feedback.show(
          toFeedback(metadataError, {
            fallback: "Failed to re-enrich metadata",
          }),
        );
      } finally {
        retryingMetadataMediaIds.remove(mediaId);
      }
    },
    [clearAllVisitData, feedback, retryingMetadataMediaIds],
  );

  const handleDeleteMedia = useCallback(
    async (entry: LibraryMediaListEntry) => {
      if (deletingMediaIds.has(entry.media.id)) return;
      deletingMediaIds.add(entry.media.id);

      try {
        const outcome = await confirmAndDeleteMedia({
          mediaId: entry.media.id,
          mediaTitle: entry.media.title,
          confirmRemoval: (message) => window.confirm(message),
        });
        if (outcome.kind === "Cancelled") return;
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
        if (result.kind === "Deleting") {
          feedback.show({
            severity: "info",
            title: "Deleting from your library",
          });
        }
        clearAllVisitData();
      } catch (err) {
        if (handleUnauthenticatedApiError(err)) return;
        if (!isApiError(err) || isSameSystemApiDefect(err)) throw err;
        feedback.show({
          ...toFeedback(err, {
            fallback: "Failed to remove media",
          }),
        });
      } finally {
        deletingMediaIds.remove(entry.media.id);
      }
    },
    [clearAllVisitData, deletingMediaIds, feedback, setEntries],
  );

  const handleSetConsumption = useCallback(
    async (mediaId: string, status: "finished" | "unread") => {
      if (
        updatingConsumptionMediaIds.has(mediaId) ||
        resettingProgressMediaIds.has(mediaId)
      ) {
        return;
      }
      updatingConsumptionMediaIds.add(mediaId);
      const previous = new Map<string, LibraryMediaConsumption>();
      for (const entry of entries) {
        if (entry.kind === "media" && entry.media.id === mediaId) {
          previous.set(entry.id, {
            read_state: entry.media.read_state,
            progress_fraction: entry.media.progress_fraction,
          });
        }
      }
      if (previous.size === 0) {
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
        if (status === "finished") {
          const parsedMediaId = parseMediaId(mediaId);
          const preCompletionSnapshot = lectern.getCanonicalSnapshot() ?? {
            items: [],
          };
          const completedItem =
            preCompletionSnapshot.items.find(
              (item) => item.mediaId === mediaId,
            ) ?? null;
          const result = await lectern.ensureMediaFinished(parsedMediaId);
          offerCompletionUndo({
            mediaId: parsedMediaId,
            preCompletionSnapshot,
            completedItemId: completedItem?.itemId ?? null,
            completionHandle: result.completionHandle,
          });
        } else {
          await lectern.setUnread(parseMediaId(mediaId));
        }
        clearAllVisitData();
      } catch (err) {
        if (
          consumptionOperationTokensRef.current.get(mediaId) !== operationToken
        ) {
          return;
        }
        setEntries((current) =>
          current.map((entry) => {
            const fields = previous.get(entry.id);
            return entry.kind === "media" &&
              entry.media.id === mediaId &&
              fields
              ? { ...entry, media: { ...entry.media, ...fields } }
              : entry;
          }),
        );
        if (handleUnauthenticatedApiError(err)) return;
        if (!isApiError(err) || isSameSystemApiDefect(err)) throw err;
        feedback.show({
          ...toFeedback(err, { fallback: "Failed to update read state" }),
        });
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
      clearAllVisitData,
      entries,
      feedback,
      lectern,
      offerCompletionUndo,
      patchMediaInViews,
      setEntries,
      resettingProgressMediaIds,
      updatingConsumptionMediaIds,
    ],
  );

  const handleResetProgress = useCallback(
    async (mediaId: string, isVideo: boolean) => {
      if (
        resettingProgressMediaIds.has(mediaId) ||
        updatingConsumptionMediaIds.has(mediaId)
      ) {
        return;
      }
      if (!viewIsCommitted || committedView === null) return;
      resettingProgressMediaIds.add(mediaId);
      try {
        const outcome = await runProgressReset({
          mediaId: parseMediaId(mediaId),
          isVideo,
          confirmReset: (message) => window.confirm(message),
          resetProgress: lectern.resetProgress,
        });
        if (outcome.kind === "Cancelled") return;
        // Immediate local patch: Reset removes the row from an In Progress view.
        // lectern.resetProgress already published the consumption revision, so a
        // consumption-sensitive view reconciles against fresh truth.
        patchMediaInViews(mediaId, (media) => ({
          ...media,
          read_state: "unread",
        }));
        feedback.show({ severity: "success", title: "Progress reset." });
      } catch (error) {
        if (handleUnauthenticatedApiError(error)) return;
        if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
        feedback.show(
          toFeedback(error, { fallback: "Failed to reset progress" }),
        );
      } finally {
        resettingProgressMediaIds.remove(mediaId);
      }
    },
    [
      committedView,
      feedback,
      lectern.resetProgress,
      patchMediaInViews,
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
        feedback.show({ severity: "success", title: "Added to Lectern" });
        clearAllVisitData();
      } catch (err) {
        if (handleUnauthenticatedApiError(err)) return;
        if (!isApiError(err) || isSameSystemApiDefect(err)) throw err;
        feedback.show({
          ...toFeedback(err, { fallback: "Failed to add to Lectern" }),
        });
      } finally {
        addingToLecternMediaIds.remove(mediaId);
      }
    },
    [addingToLecternMediaIds, clearAllVisitData, feedback, lectern],
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
        if (!isApiError(removeError) || isSameSystemApiDefect(removeError)) {
          throw removeError;
        }
        feedback.show(
          toFeedback(removeError, {
            fallback: "Failed to remove from Lectern",
          }),
        );
      } finally {
        removingFromLecternMediaIds.remove(mediaId);
      }
    },
    [clearAllVisitData, feedback, lectern, removingFromLecternMediaIds],
  );

  const handleRefreshPodcast = async (
    entry: LibraryPodcastListEntry,
  ): Promise<void> => {
    const podcastId = entry.podcast.id;
    if (refreshingPodcastIds.has(podcastId)) return;
    refreshingPodcastIds.add(podcastId);
    try {
      const result = await refreshPodcastSubscriptionSync(podcastId);
      const syncStatus = decodePodcastSyncStatus(
        result.sync_status,
        "podcast sync_status",
      );
      setEntries((current) =>
        current.map((candidate) =>
          candidate.kind === "podcast" && candidate.podcast.id === podcastId
            ? {
                ...candidate,
                podcast: {
                  ...candidate.podcast,
                  syncStatus: present(syncStatus),
                },
                subscription: candidate.subscription
                  ? {
                      ...candidate.subscription,
                      sync_status: result.sync_status,
                    }
                  : null,
              }
            : candidate,
        ),
      );
      clearAllVisitData();
    } catch (refreshError) {
      if (handleUnauthenticatedApiError(refreshError)) return;
      if (!isApiError(refreshError) || isSameSystemApiDefect(refreshError)) {
        throw refreshError;
      }
      feedback.show(
        toFeedback(refreshError, {
          fallback: "Failed to refresh podcast sync",
        }),
      );
    } finally {
      refreshingPodcastIds.remove(podcastId);
    }
  };

  const handleUnsubscribePodcast = async (
    entry: LibraryPodcastListEntry,
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
      await unsubscribeFromPodcast(podcastId);
      const currentPlacement = placements.find(
        (placement) => placement.id === id,
      );
      setEntries((current) =>
        current.flatMap((candidate) => {
          if (
            candidate.kind !== "podcast" ||
            candidate.podcast.id !== podcastId
          ) {
            return [candidate];
          }
          return currentPlacement?.canRemove
            ? []
            : [{ ...candidate, subscription: null }];
        }),
      );
      clearAllVisitData();
    } catch (unsubscribeError) {
      if (handleUnauthenticatedApiError(unsubscribeError)) return;
      if (
        !isApiError(unsubscribeError) ||
        isSameSystemApiDefect(unsubscribeError)
      ) {
        throw unsubscribeError;
      }
      feedback.show(
        toFeedback(unsubscribeError, {
          fallback: "Failed to unsubscribe from podcast",
        }),
      );
    } finally {
      unsubscribingPodcastIds.remove(podcastId);
    }
  };

  const handleDeleteLibrary = async () => {
    if (
      !currentLibrary ||
      currentLibrary.isDefault ||
      deletingLibraryRef.current
    ) {
      return;
    }
    if (!confirm(`Delete "${currentLibrary.name}"? This cannot be undone.`)) {
      return;
    }

    deletingLibraryRef.current = true;
    setDeletingLibrary(true);
    try {
      await apiFetch(`/api/libraries/${currentLibrary.id}`, {
        method: "DELETE",
      });
      // Deletion can change visible membership and many placements: publish an
      // Unknown-scope placement advance so every mounted pane reconciles.
      publishLibraryPlacementChange("Unknown");
      committedSnapshotRef.current = null;
      clearAllVisitData();
      router.push("/libraries");
    } catch (err) {
      if (handleUnauthenticatedApiError(err)) return;
      if (!isApiError(err) || isSameSystemApiDefect(err)) throw err;
      setError(
        toFeedback(err, {
          fallback: "Failed to delete library",
        }),
      );
    } finally {
      deletingLibraryRef.current = false;
      setDeletingLibrary(false);
    }
  };

  const handleRename = useCallback(
    async (name: string) => {
      if (!currentLibrary) return;
      await apiFetch(`/api/libraries/${currentLibrary.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      });
      setLibrary({ ...currentLibrary, name });
      clearAllVisitData();
    },
    [clearAllVisitData, currentLibrary, setLibrary],
  );

  const handleDeleteFromSettings = useCallback(async () => {
    if (!currentLibrary) return;
    await apiFetch(`/api/libraries/${currentLibrary.id}`, {
      method: "DELETE",
    });
    publishLibraryPlacementChange("Unknown");
    committedSnapshotRef.current = null;
    clearAllVisitData();
    setSettingsOpen(false);
    router.push("/libraries");
  }, [clearAllVisitData, currentLibrary, router]);

  const handleLoadMoreEntries = useCallback(() => {
    if (
      entryCursor === null ||
      loadingMore ||
      committedView === null ||
      !viewIsCommitted ||
      entryReconciliationRequest !== null
    ) {
      return;
    }
    entryLoadMoreAbortRef.current?.abort();
    const generation = entryLoadMoreGenerationRef.current + 1;
    entryLoadMoreGenerationRef.current = generation;
    const controller = new AbortController();
    entryLoadMoreAbortRef.current = controller;
    setLoadingMore(true);
    setLoadMoreError(null);
    void apiFetch<LibraryEntryPageWire>(
      libraryEntriesResource.clientPath({
        id,
        view: committedView,
        cursor: entryCursor,
      }),
      { signal: controller.signal },
    )
      .then(decodeLibraryEntryPage)
      .then((page) => {
        if (
          controller.signal.aborted ||
          generation !== entryLoadMoreGenerationRef.current
        ) {
          return;
        }
        setEntries((current) =>
          appendUniqueEntries(current, page.data, (entry) =>
            libraryRowKey(entry, isDefaultLibrary),
          ),
        );
        setEntryCursor(page.page.next_cursor);
      })
      .catch((err: unknown) => {
        if (
          isAbortError(err) ||
          controller.signal.aborted ||
          generation !== entryLoadMoreGenerationRef.current
        ) {
          return;
        }
        if (handleUnauthenticatedApiError(err)) return;
        // A stale/deployment-era continuation cursor is never reinterpreted as
        // an invalid view: the list can no longer continue and offers Refresh
        // list, which reloads the same view's first page.
        if (isApiError(err) && err.code === "E_INVALID_CURSOR") {
          setLoadMoreCursorInvalid(true);
          return;
        }
        setLoadMoreError(
          toFeedback(err, { fallback: "Failed to load more entries" }),
        );
      })
      .finally(() => {
        if (
          controller.signal.aborted ||
          generation !== entryLoadMoreGenerationRef.current
        ) {
          return;
        }
        setLoadingMore(false);
      });
  }, [
    committedView,
    entryCursor,
    entryReconciliationRequest,
    id,
    isDefaultLibrary,
    loadingMore,
    setEntries,
    setEntryCursor,
    viewIsCommitted,
  ]);

  // Recover from a stale/deployment-era continuation cursor: discard it and
  // reload the same exact view's first page. On success focus the View select.
  const handleRefreshList = useCallback(() => {
    if (committedView === null) return;
    // Keep "This list can no longer continue." + "Refresh list" mounted until the
    // replacement first page COMMITS: the commit path clears loadMoreCursorInvalid
    // and focuses View; a failed refresh leaves the same notice and focused button
    // in place (never a generic Retry state that unmounts the button).
    pendingCommitFocusRef.current = "View";
    requestEntryReconciliation(committedView, {
      placement: placementRevisionRef.current,
      consumption: consumptionRevisionRef.current,
    });
  }, [committedView, requestEntryReconciliation]);

  const handleReorderEntries = (nextEntries: LibraryEntry[]) => {
    if (!viewIsCommitted || !canReorder || entryCursor !== null) {
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
      body: JSON.stringify({ entry_ids: nextEntries.map((entry) => entry.id) }),
    })
      .then(() => {
        if (generation !== reorderGenerationRef.current) return;
        clearAllVisitData();
      })
      .catch((err: unknown) => {
        if (generation !== reorderGenerationRef.current) return;
        setEntries(previousEntries);
        if (handleUnauthenticatedApiError(err)) return;
        if (isApiError(err)) {
          setError(
            toFeedback(err, {
              fallback: "Failed to reorder library entries",
            }),
          );
          return;
        }
        setError({
          severity: "error",
          title: "Failed to reorder library entries",
        });
      })
      .finally(() => {
        if (generation !== reorderGenerationRef.current) return;
        setReorderBusy(false);
      });
  };

  const paneResourceGroups = currentLibrary
    ? libraryResourceOptions({
        settings: currentLibrary.canRename
          ? {
              kind: "Available",
              execute: () => setSettingsOpen(true),
            }
          : { kind: "Unavailable" },
        deleteLibrary: currentLibrary.canDelete
          ? {
              kind: "Available",
              execute: handleDeleteLibrary,
            }
          : { kind: "Unavailable" },
        busyIds: deletingLibrary
          ? new Set<ResourceActionId>([
              RESOURCE_ACTION_CATALOG.DeleteLibrary.id,
            ])
          : new Set<ResourceActionId>(),
      })
    : null;
  const addContentAction: ActionDescriptor[] =
    currentLibrary && canEditEntries && viewIsCommitted
      ? [
          {
            kind: "command",
            id: "ViewAction.Library.AddContent",
            label: "Add content",
            restoreFocusOnClose: false,
            onSelect: () =>
              dispatchOpenLauncher({
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
      if (removedEntryIds.ids.has(entry.id)) return false;
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
  const visibleEntries = entries.filter(isVisibleEntry);
  const entryFolioCount = visibleEntries.length;
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
  usePanePrimaryChrome({
    actions: companionAction ? [companionAction] : [],
    menu:
      currentLibrary && paneResourceGroups
        ? {
            kind: "ResourceMenu",
            target: routeResourceActionSubject({
              scheme: "library",
              id: currentLibrary.id,
              href: `/libraries/${currentLibrary.id}`,
            }),
            groups: {
              core: [],
              operations: paneResourceGroups.operations,
              relationships: paneResourceGroups.relationships,
              view: addContentAction,
            },
          }
        : undefined,
    header: {
      kind: "section",
      folio: { kind: "count", value: entryFolioCount, unit: "entry" },
      pending: loading,
    },
  });

  const visibleRowSignature = visibleEntries
    .map((entry) => libraryRowKey(entry, isDefaultLibrary))
    .join("");
  useEffect(() => {
    const neighborKey = pendingFocusNeighborRef.current;
    if (neighborKey === undefined) return;
    pendingFocusNeighborRef.current = undefined;
    const moveFocus = () => {
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
      if (viewSelectRef.current) {
        viewSelectRef.current.focus();
        return;
      }
      sortSelectRef.current?.focus();
    };
    // Defer past the menu's own focus-restore and the row-removal reflow so the
    // sibling (not the vanished trigger) ends up focused.
    const outer = requestAnimationFrame(() => {
      const inner = requestAnimationFrame(moveFocus);
      pendingFocusRafRef.current = inner;
    });
    pendingFocusRafRef.current = outer;
    return () => cancelAnimationFrame(pendingFocusRafRef.current);
  }, [visibleRowSignature]);

  if (firstPageDefect !== null) {
    throw firstPageDefect;
  }

  if (loading) {
    return <PaneLoadingState />;
  }

  // Pre-metadata only: no committed page AND no route-resource metadata. Once
  // metadata is known (knownLibrary), the pane falls through to render its
  // toolbar plus the polite status node — even before the first page commits.
  if (!knownLibrary) {
    if (viewInvalid) {
      return (
        <FeedbackNotice severity="error" title="Invalid library view">
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              setDecodedView({ kind: "Valid", view: CANONICAL_VIEW })
            }
          >
            Reset view
          </Button>
        </FeedbackNotice>
      );
    }
    if (failedFirstPage !== null) {
      return (
        <FeedbackNotice
          feedback={toFeedback(failedFirstPage.error, {
            fallback: "Failed to load library entries",
          })}
        >
          <Button variant="secondary" size="sm" onClick={failedFirstPage.retry}>
            Retry
          </Button>
        </FeedbackNotice>
      );
    }
    return (
      <FeedbackNotice
        {...(error ?? { severity: "error", title: "Library not found" })}
      />
    );
  }

  const invalidView = decodedView.kind === "Invalid" || viewInvalid;
  const entryRegionId = `library-entry-region-${id}`;
  // Reorder exists only for a fully loaded editable non-default
  // Canonical + AllItems(All) list.
  const canReorderVisibleEntries =
    viewIsCommitted &&
    canReorder &&
    committedView?.order.kind === "Canonical" &&
    committedView.projection.kind === "AllItems" &&
    committedView.projection.completion === "all" &&
    entryCursor === null;
  const entryFooter = loadMoreCursorInvalid ? (
    <FeedbackNotice
      severity="neutral"
      title="This list can no longer continue."
    >
      <Button variant="secondary" size="sm" onClick={handleRefreshList}>
        Refresh list
      </Button>
    </FeedbackNotice>
  ) : (
    <>
      {loadMoreError ? <FeedbackNotice {...loadMoreError} /> : null}
      <LoadMoreFooter
        hasMore={
          viewIsCommitted &&
          entryReconciliationRequest === null &&
          entryCursor !== null
        }
        loading={loadingMore}
        onLoadMore={handleLoadMoreEntries}
        label="Load more entries"
      />
    </>
  );
  // While the stale-cursor recovery is mounted, the Refresh-list reconciliation
  // is surfaced by that notice/button (kept until the replacement page commits),
  // not by a second "Refreshing…" notice.
  const entryReconciliationNotice =
    entryReconciliationRequest && !loadMoreCursorInvalid ? (
      entryReconciliationFetch.error === null ? (
        <FeedbackNotice
          severity="neutral"
          title="Refreshing library entries…"
        />
      ) : (
        <FeedbackNotice
          feedback={toFeedback(
            toLibraryAddError(entryReconciliationFetch.error),
            {
              fallback: "Failed to refresh library entries",
            },
          )}
        >
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              requestEntryReconciliation(entryReconciliationRequest.view, {
                placement: placementRevisionRef.current,
                consumption: consumptionRevisionRef.current,
              })
            }
          >
            Retry
          </Button>
        </FeedbackNotice>
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
    const iso =
      isDefaultLibrary && entry.kind === "media"
        ? entry.media.created_at
        : entry.created_at;
    const label = isDefaultLibrary ? "Added to Nexus " : "Added ";
    return present({ kind: "Text", text: `${label}${formatAdded(iso)}` });
  };

  const entryRowView = (item: LibraryEntry): CollectionRowView => {
    const showAdded = committedView?.order.kind === "Added";
    if (item.kind === "podcast") {
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
          connectionSummary: connectionSummaries.get(
            `podcast:${item.podcast.id}`,
          ),
          settings:
            viewIsCommitted && item.subscription?.status === "active"
              ? {
                  kind: "Available",
                  execute: () =>
                    podcastSettingsModal.open({
                      podcast_id: item.podcast.id,
                      default_playback_speed:
                        item.subscription?.default_playback_speed,
                      auto_queue: item.subscription?.auto_queue,
                    }),
                }
              : { kind: "Unavailable" },
          refreshSync:
            viewIsCommitted && item.subscription?.status === "active"
              ? {
                  kind: "Available",
                  execute: () => handleRefreshPodcast(item),
                }
              : { kind: "Unavailable" },
          subscription:
            viewIsCommitted && item.subscription?.status === "active"
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
        id: item.id,
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
      connectionSummary: connectionSummaries.get(`media:${item.media.id}`),
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
              execute: (detail) => openAuthorsEditor(item.media.id, detail),
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
                // Reset drops the row from an In Progress view (read_state ->
                // unread); capture the focus neighbor before it leaves.
                if (isInProgressView) {
                  captureFocusNeighbor(libraryRowKey(item, isDefaultLibrary));
                }
                return handleResetProgress(
                  item.media.id,
                  item.media.kind === "video",
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
  const visibleEntryRows = visibleEntries.map(entryRowView);

  const orderPresetIds = orderPresetIdsFor(isDefaultLibrary);
  const projectionOptions = projectionOptionsFor(isDefaultLibrary);
  const toolbar =
    invalidView || view === null ? undefined : (
      <PaneToolbar
        filters={
          <>
            <label className={styles.selectField}>
              <span>View</span>
              <Select
                ref={viewSelectRef}
                value={projectionOptionOf(view)}
                onChange={(event) => {
                  pendingCommitFocusRef.current = null;
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
                  pendingCommitFocusRef.current = null;
                  setView({
                    order: presetIdToOrder(
                      event.target.value as LibraryOrderPresetId,
                    ),
                    projection: view.projection,
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
                  pendingCommitFocusRef.current = null;
                  setView(withCompletion(view, checked ? "unfinished" : "all"));
                }}
                label="Hide finished"
              />
            ) : null}
          </>
        }
      />
    );

  const entriesAccessibleName = libraryPresentation(knownLibrary).name;
  // Both recoveries request AllItems(All) preserving order and focus View; the
  // completion-only "Show finished" recovery focuses the Hide-finished checkbox.
  const recoverToAllItems = () => {
    if (committedView === null) return;
    pendingCommitFocusRef.current = "View";
    setView({
      order: committedView.order,
      projection: { kind: "AllItems", completion: "all" },
    });
  };
  const recoverShowFinished = () => {
    if (committedView === null) return;
    pendingCommitFocusRef.current = "HideFinished";
    setView(withCompletion(committedView, "all"));
  };
  // Closed-union empty-state precedence (never inferred from counts).
  const emptyStateNotice = (() => {
    const projection = committedView?.projection ?? CANONICAL_VIEW.projection;
    if (projection.kind === "InProgress") {
      return (
        <FeedbackNotice severity="neutral" title="Nothing in progress.">
          <Button variant="secondary" size="sm" onClick={recoverToAllItems}>
            Show all items
          </Button>
        </FeedbackNotice>
      );
    }
    if (projection.kind === "Unfiled") {
      return projection.completion === "all" ? (
        <FeedbackNotice severity="neutral" title="Everything is filed.">
          <Button variant="secondary" size="sm" onClick={recoverToAllItems}>
            Show all items
          </Button>
        </FeedbackNotice>
      ) : (
        <FeedbackNotice severity="neutral" title="No unfinished unfiled items.">
          <Button variant="secondary" size="sm" onClick={recoverToAllItems}>
            Clear filters
          </Button>
        </FeedbackNotice>
      );
    }
    return projection.completion === "all" ? (
      <FeedbackNotice
        severity="neutral"
        title={
          isDefaultLibrary
            ? "No media yet."
            : "No podcasts or media in this library yet."
        }
      />
    ) : (
      <FeedbackNotice severity="neutral" title="No unfinished items.">
        <Button variant="secondary" size="sm" onClick={recoverShowFinished}>
          Show finished
        </Button>
      </FeedbackNotice>
    );
  })();
  const mainBody = invalidView ? (
    <FeedbackNotice severity="error" title="Invalid library view">
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setDecodedView({ kind: "Valid", view: CANONICAL_VIEW })}
      >
        Reset view
      </Button>
    </FeedbackNotice>
  ) : visibleEntries.length > 0 ? (
    <CollectionView
      returnScope="Library.Entries"
      rows={visibleEntryRows}
      status="ready"
      ariaLabel={entriesAccessibleName}
      rowActionsAvailable={viewIsCommitted}
      footer={entryFooter}
      surface={false}
      sortable={
        canReorderVisibleEntries
          ? {
              disabled: reorderBusy,
              onReorder: (nextRows) => {
                const byEntryId = new Map(
                  visibleEntries.map((entry) => [entry.id, entry]),
                );
                const nextEntries = nextRows
                  .map((row) => byEntryId.get(row.id))
                  .filter(
                    (entry): entry is LibraryEntry => entry !== undefined,
                  );
                if (nextEntries.length === visibleEntries.length) {
                  handleReorderEntries(nextEntries);
                }
              },
            }
          : undefined
      }
    />
  ) : currentLibrary ===
    null ? // Metadata known but no page has committed yet: the busy region stays empty
  // (rows/empty-state only); the polite status node carries "Loading …" /
  // "Could not load …". No false empty-state notice before the first commit.
  null : entryCursor !== null ? (
    // Empty after local filtering while the server still has another page:
    // keep the explicit continuation control visible instead of publishing a
    // false empty state or initiating an effect-owned GET.
    entryFooter
  ) : (
    emptyStateNotice
  );
  const podcastSettingsEntry = entries.find(
    (entry) =>
      entry.kind === "podcast" &&
      entry.podcast.id === podcastSettingsModal.podcastId,
  );
  const podcastSettingsTitle =
    podcastSettingsEntry?.kind === "podcast"
      ? podcastSettingsEntry.podcast.title
      : null;

  return (
    <>
      <PaneSurface
        opener={<SectionOpener heading={entriesAccessibleName} scale="title" />}
        toolbar={toolbar}
        state={
          error || entryReconciliationNotice ? (
            <>
              {error ? <FeedbackNotice {...error} /> : null}
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
              failedFirstPage === null)
              ? true
              : undefined
          }
        >
          {mainBody}
        </div>
        {currentLibrary !== null ? (
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

      {settingsOpen && currentLibrary ? (
        <LibrarySettingsDialog
          open
          onClose={() => setSettingsOpen(false)}
          library={{
            id: currentLibrary.id,
            name: currentLibrary.name,
            canRename: currentLibrary.canRename,
            canDelete: currentLibrary.canDelete,
          }}
          onRename={handleRename}
          onDelete={handleDeleteFromSettings}
        />
      ) : null}
      <PodcastSubscriptionSettingsModal
        podcastTitle={podcastSettingsTitle}
        settingsModal={podcastSettingsModal}
      />
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
