"use client";

import { Plus } from "lucide-react";
import {
  useCallback,
  useId,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import CollectionExhaustionNotice from "@/components/collections/CollectionExhaustionNotice";
import CollectionView from "@/components/collections/CollectionView";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import { isApiError, isInvalidViewError } from "@/lib/api/client";
import { useChangeStamp } from "@/lib/api/changes";
import { librariesResource } from "@/lib/api/resource";
import { useResourceSeed } from "@/lib/api/resourceCache";
import { usePaneUrlState } from "@/lib/api/usePaneUrlState";
import { useResource } from "@/lib/api/useResource";
import {
  listRowStatus,
  useServerList,
  type ListPage,
  type ListSnapshot,
} from "@/lib/api/useServerList";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { presentLibrary } from "@/lib/collections/presenters/library";
import { isAbortError } from "@/lib/errors";
import { createLibrary, fetchLibrariesPage } from "@/lib/libraries/client";
import type {
  LibraryOut,
  ViewerLibraryInvitation,
} from "@/lib/libraries/contract";
import {
  acceptLibraryInvite,
  declineLibraryInvite,
  fetchViewerLibraryInvites,
} from "@/lib/libraries/governance";
import {
  CANONICAL_LIBRARIES_INDEX_VIEW,
  LIBRARIES_SORT_OPTION_IDS,
  decodeLibrariesIndexView,
  encodeLibrariesIndexView,
  librariesSortOptionLabel,
  librariesSortOptionOf,
  librariesViewForSortOption,
  type DecodedLibrariesIndexView,
  type LibrariesIndexView,
  type LibrariesSortOptionId,
} from "@/lib/libraries/libraryIndexView";
import {
  libraryRequestErrorMessage,
  type LibraryRequest,
} from "@/lib/libraries/libraryRequestErrorMessage";
import {
  isReservedLibraryName,
  libraryPresentation,
  RESERVED_LIBRARY_NAME_MESSAGE,
} from "@/lib/libraries/presentation";
import PaneQueryToolbar from "@/components/workspace/PaneQueryToolbar";
import PaneFilterRowsStatus from "@/components/workspace/PaneFilterRowsStatus";
import { usePaneQueryInput } from "@/components/workspace/usePaneQueryInput";
import {
  truncatePaneSearchQuery,
  usePaneChrome,
  type PaneRefreshExecute,
} from "@/lib/panes/paneChrome";
import { matchesPaneFilterQuery } from "@/lib/panes/paneFilterRows";
import {
  requirePaneRuntime,
  usePaneIsActive,
  usePaneRuntime,
} from "@/lib/panes/paneRuntime";
import { findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
import {
  definePaneVisitDataKey,
  usePaneReturnReady,
  usePaneScrollRetention,
  usePaneVisitData,
  usePaneVisitDataWriter,
} from "@/lib/workspace/paneReturnMemento";
import LibraryCreationDialog, {
  type Attempt,
  type Creation,
  type DraftFeedback,
} from "./LibraryCreationDialog";
import styles from "./page.module.css";

const VISIT =
  definePaneVisitDataKey<ListSnapshot<LibraryOut>>("Libraries.Index");
const CREATION_VISIT = definePaneVisitDataKey<Attempt>("Libraries.Creation");
const FILTER_VISIT = definePaneVisitDataKey<string>("Libraries.Filter");
const CREATE_DEADLINE_MS = 30_000;
const UNCONFIRMED: FeedbackContent = {
  tone: "Warning",
  title: "creation not confirmed",
  message: "this library may already exist. retry before creating another library.",
};
const UNIT = { singular: "library", plural: "libraries" };
// The pane URL owns the index view through a strict, total codec.
const VIEW_CODEC = {
  basePath: "/libraries",
  decode: decodeLibrariesIndexView,
  encode: (decoded: DecodedLibrariesIndexView, current: URLSearchParams) =>
    encodeLibrariesIndexView(
      decoded.kind === "Valid" ? decoded.view : CANONICAL_LIBRARIES_INDEX_VIEW,
      current,
    ),
  replaceOptions: { viewTransition: { kind: "collection-reflow" as const } },
};
const keyOf = (view: LibrariesIndexView) =>
  librariesResource.cacheKey({ view });

function nameFeedback(name: string): DraftFeedback | null {
  if (name.length === 0)
    return { tone: "Danger", title: "enter a library name.", nameInvalid: true };
  if (Array.from(name).length > 100)
    return { tone: "Danger", title: "use 100 characters or fewer.", nameInvalid: true };
  if (isReservedLibraryName(name))
    return { tone: "Danger", title: RESERVED_LIBRARY_NAME_MESSAGE, nameInvalid: true };
  return null;
}

export default function LibrariesPaneBody() {
  const runtime = requirePaneRuntime(usePaneRuntime(), "LibrariesPaneBody");
  const isActive = usePaneIsActive();
  const { state: decoded, setState: setDecoded } = usePaneUrlState(VIEW_CODEC);
  const view = decoded.kind === "Valid" ? decoded.view : null;
  const seed = useResourceSeed<ListPage<LibraryOut>>(
    keyOf(CANONICAL_LIBRARIES_INDEX_VIEW),
  );
  const list = useServerList<LibraryOut>({
    key: view === null ? null : keyOf(view),
    stale: useChangeStamp("Libraries"),
    pageSize: 100,
    drain: true,
    active: isActive,
    visit: VISIT,
    seed: seed && { key: keyOf(CANONICAL_LIBRARIES_INDEX_VIEW), page: seed },
    id: (library) => library.id,
    fetchPage: (cursor, limit, signal) =>
      fetchLibrariesPage({
        view: view ?? CANONICAL_LIBRARIES_INDEX_VIEW,
        cursor,
        limit,
        signal,
      }),
  });
  // The server rejects a view the URL codec admitted: a terminal, resettable state.
  const invalid =
    view === null ||
    (list.failure?.op === "Load" && isInvalidViewError(list.failure.error));
  usePaneReturnReady(list.status !== "loading" || invalid);
  const captureScroll = usePaneScrollRetention(list.items);
  const setView = useCallback(
    (next: LibrariesIndexView) => {
      captureScroll();
      setDecoded({ kind: "Valid", view: next });
    },
    [captureScroll, setDecoded],
  );

  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const presentFailure = useCallback(
    (error: unknown, title: string, request: LibraryRequest) => {
      try {
        setFeedback(libraryRequestErrorMessage(error, { title, request }));
      } catch (caught) {
        setDefect({ error: caught });
      }
    },
    [],
  );
  const loadFailure =
    list.failure !== null && list.failure.op !== "More" && !invalid
      ? libraryRequestErrorMessage(list.failure.error, {
          title:
            list.status === "ready"
              ? "Libraries couldn’t be refreshed"
              : "Libraries couldn’t be loaded",
          request: "LibraryCollectionRead",
        })
      : null;

  const creationRef = useRef<Creation>({
    kind: "Draft",
    text: "",
    feedback: null,
  });
  const restoredAttempt = usePaneVisitData(CREATION_VISIT, () => {
    const current = creationRef.current;
    return current.kind === "Sending" || current.kind === "Unconfirmed"
      ? current.attempt
      : null;
  });
  const [creation, setCreation] = useState<Creation>(() => {
    if (restoredAttempt) {
      creationRef.current = {
        kind: "Unconfirmed",
        attempt: restoredAttempt,
        feedback: UNCONFIRMED,
      };
    }
    return creationRef.current;
  });
  const writeAttempt = usePaneVisitDataWriter(CREATION_VISIT);
  const transitionCreation = (next: Creation) => {
    creationRef.current = next;
    writeAttempt(
      next.kind === "Sending" || next.kind === "Unconfirmed" ? next.attempt : null,
    );
    setCreation(next);
  };
  const [creationOpen, setCreationOpen] = useState(false);
  const creationOpenRef = useRef(false);
  const creationTrigger = useRef<HTMLElement | null>(null);
  const skipCreationReturnFocus = useRef(false);
  const validationStarted = useRef(false);
  const delivery = useRef<{
    visitId: string;
    mayNavigate: boolean;
  } | null>(null);
  const owner = useRef({
    mounted: false,
    active: isActive,
    visitId: runtime.visitId,
  });
  useLayoutEffect(() => {
    owner.current.active = isActive;
    owner.current.visitId = runtime.visitId;
    if (
      delivery.current &&
      (!isActive || delivery.current.visitId !== runtime.visitId)
    ) {
      delivery.current.mayNavigate = false;
    }
  }, [isActive, runtime.visitId]);
  useLayoutEffect(() => {
    const mountedOwner = owner.current;
    mountedOwner.mounted = true;
    return () => {
      mountedOwner.mounted = false;
      if (delivery.current) delivery.current.mayNavigate = false;
    };
  }, []);

  const openCreation = (trigger: HTMLElement | null) => {
    const current = creationRef.current;
    if (current.kind === "Draft" || current.kind === "Created") {
      validationStarted.current = false;
      transitionCreation({ kind: "Draft", text: "", feedback: null });
    }
    creationTrigger.current = trigger;
    skipCreationReturnFocus.current = false;
    creationOpenRef.current = true;
    setCreationOpen(true);
  };
  const closeCreation = () => {
    if (delivery.current) delivery.current.mayNavigate = false;
    creationOpenRef.current = false;
    if (creationRef.current.kind === "Draft") {
      validationStarted.current = false;
      transitionCreation({ kind: "Draft", text: "", feedback: null });
    }
    setCreationOpen(false);
  };
  const openCreatedLibrary = (library: LibraryOut) => {
    skipCreationReturnFocus.current = true;
    creationOpenRef.current = false;
    setCreationOpen(false);
    runtime.router.push(`/libraries/${encodeURIComponent(library.id)}`, {
      labelHint: libraryPresentation(library).name,
    });
  };
  const submitCreation = async (focusName: () => void) => {
    if (delivery.current) return;
    const current = creationRef.current;
    let attempt: Attempt;
    let wasUnconfirmed: boolean;
    switch (current.kind) {
      case "Draft": {
        validationStarted.current = true;
        const name = current.text.trim();
        const invalidName = nameFeedback(name);
        if (invalidName) {
          transitionCreation({ ...current, feedback: invalidName });
          focusName();
          return;
        }
        attempt = { libraryId: crypto.randomUUID(), name };
        wasUnconfirmed = false;
        break;
      }
      case "Unconfirmed":
        attempt = current.attempt;
        wasUnconfirmed = true;
        break;
      case "Sending":
        return;
      case "Created":
        openCreatedLibrary(current.library);
        return;
    }
    const flight = { visitId: runtime.visitId, mayNavigate: true };
    delivery.current = flight;
    transitionCreation({ kind: "Sending", attempt, wasUnconfirmed });
    const signal = AbortSignal.timeout(CREATE_DEADLINE_MS);
    const ownsDelivery = () =>
      owner.current.mounted &&
      owner.current.visitId === flight.visitId &&
      delivery.current === flight;
    try {
      const library = await createLibrary({ ...attempt, signal });
      if (!ownsDelivery()) return;
      // Record settlement before navigation can unmount this visit.
      transitionCreation({ kind: "Created", library });
      if (owner.current.active && creationOpenRef.current && flight.mayNavigate)
        openCreatedLibrary(library);
    } catch (error) {
      if (!ownsDelivery()) return;
      if (handleUnauthenticatedApiError(error)) return;
      try {
        if (
          signal.aborted &&
          (isAbortError(error) ||
            error === signal.reason ||
            (isApiError(error) && error.code === "E_NETWORK"))
        ) {
          transitionCreation({
            kind: "Unconfirmed",
            attempt,
            feedback: UNCONFIRMED,
          });
          return;
        }
        if (!isApiError(error)) throw error;
        switch (error.code) {
          case "E_NAME_INVALID":
          case "E_INVALID_REQUEST":
          case "E_FORBIDDEN": {
            const failure = libraryRequestErrorMessage(error, {
              title: "library wasn’t created",
              request: "LibraryCreate",
            });
            transitionCreation(
              wasUnconfirmed
                ? {
                    kind: "Unconfirmed",
                    attempt,
                    feedback: { ...failure, ...UNCONFIRMED },
                  }
                : {
                    kind: "Draft",
                    text: attempt.name,
                    feedback: { ...failure, nameInvalid: error.code === "E_NAME_INVALID" },
                  },
            );
            if (!wasUnconfirmed && error.code === "E_NAME_INVALID" && creationOpenRef.current)
              focusName();
            break;
          }
          case "E_NETWORK":
          case "E_UPSTREAM":
          case "E_UPSTREAM_TIMEOUT":
          case "E_RATE_LIMITED": {
            const failure = libraryRequestErrorMessage(error, {
              title: UNCONFIRMED.title,
              request: "LibraryCreate",
            });
            transitionCreation({
              kind: "Unconfirmed",
              attempt,
              feedback: { ...failure, ...UNCONFIRMED },
            });
            break;
          }
          default:
            // justify-defect: every expected create refusal/transport outcome is handled above.
            throw error;
        }
      } catch (caught) {
        setDefect({ error: caught });
      }
    } finally {
      if (ownsDelivery()) delivery.current = null;
    }
  };

  const [invitesVersion, setInvitesVersion] = useState(0);
  const invites = useResource<ViewerLibraryInvitation[]>({
    cacheKey: `viewer-library-invites:${invitesVersion}`,
    load: fetchViewerLibraryInvites,
  });
  // The last loaded invitations stay shown while a reload runs.
  const [pendingInvites, setPendingInvites] = useState<
    ViewerLibraryInvitation[]
  >([]);
  useEffect(() => {
    if (invites.status === "ready") setPendingInvites(invites.data);
  }, [invites]);
  const [busyInvitation, setBusyInvitation] = useState<string | null>(null);
  const [declining, setDeclining] = useState<string | null>(null);
  const invitationHeadingId = useId();
  const answer = async (
    invite: ViewerLibraryInvitation,
    action: "accept" | "decline",
  ) => {
    if (busyInvitation !== null) return;
    setBusyInvitation(invite.invitationHandle);
    try {
      if (action === "accept")
        await acceptLibraryInvite(invite.invitationHandle);
      else await declineLibraryInvite(invite.invitationHandle);
      setFeedback(null);
      setPendingInvites((current) =>
        current.filter(
          (row) => row.invitationHandle !== invite.invitationHandle,
        ),
      );
      setDeclining(null);
      setInvitesVersion((version) => version + 1);
    } catch (error) {
      if (!handleUnauthenticatedApiError(error)) {
        presentFailure(
          error,
          action === "accept"
            ? "Invitation couldn’t be accepted"
            : "Invitation couldn’t be declined",
          "InvitationMutation",
        );
      }
    } finally {
      setBusyInvitation(null);
    }
  };

  const rows = list.items.map((library) => presentLibrary(library));
  const restoredQuery: string | null = usePaneVisitData(FILTER_VISIT, (): string => query);
  const [query, setQuery] = useState<string>(restoredQuery ?? "");
  const clearQuery = useCallback(() => setQuery(""), []);
  const rowStatus = listRowStatus(
    list,
    list.items.length,
    list.items.filter((library) =>
      matchesPaneFilterQuery(query, [libraryPresentation(library).name]),
    ).length,
    UNIT,
  );
  const filtering = query.trim() !== "";
  const { inputRef, focusInput } = usePaneQueryInput();
  const queryStatusId = useId();
  const resetView = useCallback(() => {
    clearQuery();
    setView(CANONICAL_LIBRARIES_INDEX_VIEW);
    requestAnimationFrame(() =>
      inputRef.current?.focus({ preventScroll: true }),
    );
  }, [clearQuery, inputRef, setView]);
  const { refetch } = list;
  const execute = useCallback<PaneRefreshExecute>(
    async ({ reportProgress }) => {
      reportProgress({
        kind: "Determinate",
        finishedCount: 0,
        requestedCount: 1,
      });
      try {
        await refetch();
        reportProgress({
          kind: "Determinate",
          finishedCount: 1,
          requestedCount: 1,
        });
        return { kind: "Complete", announcement: "Libraries refreshed" };
      } catch (error) {
        if (isAbortError(error)) throw error;
        return { kind: "Failed", announcement: "Libraries failed to refresh" };
      }
    },
    [refetch],
  );
  usePaneChrome({
    primaryAction: {
      id: "Libraries.Create",
      label: "new library",
      shortLabel: "new",
      icon: <Plus size={16} aria-hidden="true" />,
      onSelect: ({ triggerEl }) => openCreation(triggerEl),
    },
    query: invalid || view === null ? undefined : {
      kind: "Controls",
      label: "Filter libraries",
      focusInput,
      content: (
        <PaneQueryToolbar
          inputRef={inputRef}
          input={{ label: "Filter libraries", placeholder: "Filter libraries", value: query, appliedValue: query, onChange: (next) => setQuery(truncatePaneSearchQuery(next)), onClear: clearQuery }}
          sort={{
            label: "Sort",
            value: librariesSortOptionOf(view),
            choices: LIBRARIES_SORT_OPTION_IDS.map((value) => ({ value, label: librariesSortOptionLabel(value) })),
            onChange: (value) => setView(librariesViewForSortOption(
              // justify-type-assertion: the select offers exactly these ids.
              value as LibrariesSortOptionId,
            )),
          }}
          status={{ id: queryStatusId, content: <PaneFilterRowsStatus id={queryStatusId} status={rowStatus} query={query} /> }}
          onReset={view.kind !== "Canonical" || query ? resetView : undefined}
        />
      ),
    },
    refresh: { kind: "Refreshable", sourceKey: "Libraries.Index", execute },
    header: {
      kind: "Section",
      // The count describes the complete committed view, never a subset.
      meta: invalid
        ? { kind: "None" }
        : list.complete
          ? { kind: "Count", value: list.items.length, unit: "library" }
          : { kind: "Pending" },
    },
  });

  if (defect) throw defect.error;
  const loadNotice = loadFailure && (
    <FeedbackNotice
      content={loadFailure}
      announcement="Assertive"
      actions={[{ label: "Retry", onClick: list.retry }]}
    />
  );
  return (
    <>
      <LibraryCreationDialog
        open={creationOpen}
        creation={creation}
        onChangeName={(text) => {
          const current = creationRef.current;
          if (current.kind !== "Draft") return;
          transitionCreation({
            kind: "Draft",
            text,
            feedback: validationStarted.current ? nameFeedback(text.trim()) : null,
          });
        }}
        onSubmit={(focusName) => void submitCreation(focusName)}
        onClose={closeCreation}
        returnFocusTo={() => creationTrigger.current}
        returnFocusFallback={() => findPaneLandmarkFocusTarget(runtime.paneId)}
        skipReturnFocus={() => skipCreationReturnFocus.current}
      />
      {!creationOpen && creation.kind === "Unconfirmed" ? (
        <div className={styles.creationNotice}>
          <FeedbackNotice content={creation.feedback} announcement="Polite">
            <Button
              variant="secondary"
              size="sm"
              onClick={(event) => openCreation(event.currentTarget)}
            >
              review creation
            </Button>
          </FeedbackNotice>
        </div>
      ) : !creationOpen && creation.kind === "Created" ? (
        <div className={styles.creationNotice}>
          <FeedbackNotice
            content={{
              tone: "Success",
              title: "library created",
              message: `“${creation.library.name}” is ready.`,
            }}
            announcement="Polite"
            actions={[{
              label: "open library",
              onClick: () => openCreatedLibrary(creation.library),
            }]}
          />
        </div>
      ) : !creationOpen && creation.kind === "Draft" && creation.feedback ? (
        <div className={styles.creationNotice}>
          <FeedbackNotice content={creation.feedback} announcement="Polite" />
        </div>
      ) : null}
      {invalid ? (
        <FeedbackNotice
          content={{ tone: "Danger", title: "Invalid libraries view" }}
          announcement="Assertive"
          actions={[{ label: "Reset view", onClick: resetView }]}
        />
      ) : (
        <>
          {invites.status === "error" ? (
            <div className={styles.invitationInbox}>
              <FeedbackNotice
                content={libraryRequestErrorMessage(invites.error, {
                  title: "Library invitations couldn’t be loaded",
                  request: "InvitationRead",
                })}
                announcement="Assertive"
                actions={[
                  {
                    label: "Retry invitations",
                    onClick: () => setInvitesVersion((version) => version + 1),
                  },
                ]}
              />
            </div>
          ) : null}
          {pendingInvites.length > 0 ? (
            <section
              className={styles.invitationInbox}
              aria-labelledby={invitationHeadingId}
            >
              <div>
                <h2 id={invitationHeadingId}>Library invitations</h2>
                <p>Accept to add the library here, or decline the invitation.</p>
              </div>
              <div className={styles.invitationRows}>
                {pendingInvites.map((invite) => {
                  const handle = invite.invitationHandle;
                  return (
                    <div className={styles.invitationRow} key={handle}>
                      <span>
                        {invite.libraryName} ·{" "}
                        {invite.role === "admin" ? "Admin" : "Member"}
                      </span>
                      {declining === handle ? (
                        <span className={styles.invitationActions}>
                          <span>Decline this invitation?</span>
                          <Button
                            variant="danger"
                            size="sm"
                            loading={busyInvitation === handle}
                            onClick={() => void answer(invite, "decline")}
                          >
                            Decline
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busyInvitation !== null}
                            onClick={() => setDeclining(null)}
                          >
                            Keep
                          </Button>
                        </span>
                      ) : (
                        <span className={styles.invitationActions}>
                          <Button
                            variant="primary"
                            size="sm"
                            loading={busyInvitation === handle}
                            disabled={busyInvitation !== null}
                            onClick={() => void answer(invite, "accept")}
                          >
                            Accept
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busyInvitation !== null}
                            onClick={() => setDeclining(handle)}
                          >
                            Decline
                          </Button>
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          ) : null}
          <div>
            <CollectionView
              returnScope="Libraries.Items"
              rows={rows.filter((row) =>
                matchesPaneFilterQuery(query, [row.title.text]),
              )}
              status={list.status === "failed" ? "error" : list.status}
              ariaLabel="Libraries"
              rowChangePresentation={{
                kind: "ImmediateOnKeyChange",
                key: query.trim(),
              }}
              collectionBusy={list.running !== null || !list.current}
              notice={
                feedback ? (
                  <FeedbackNotice content={feedback} announcement="Assertive" />
                ) : list.status === "loading" && filtering ? (
                  <FeedbackNotice
                    content={{
                      tone: "Neutral",
                      title: "No matching library found so far.",
                    }}
                    announcement="Polite"
                  />
                ) : undefined
              }
              error={list.status === "failed" ? loadNotice : undefined}
              empty={
                <FeedbackNotice
                  content={
                    filtering
                      ? {
                          tone: "Neutral",
                          title: list.complete
                            ? "No libraries match this filter."
                            : "No matching library found so far.",
                        }
                      : {
                          tone: "Neutral",
                          title: "no libraries yet.",
                          message: "use new library to create one.",
                        }
                  }
                  announcement="Polite"
                />
              }
              footer={
                list.status === "ready" ? (
                  <>
                    <CollectionExhaustionNotice list={list} />
                    {loadNotice}
                  </>
                ) : null
              }
            />
          </div>
        </>
      )}
    </>
  );
}
