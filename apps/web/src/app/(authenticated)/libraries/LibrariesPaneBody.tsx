"use client";

// The viewer's libraries and invitations, with a pane-owned creation task.
// Sort belongs to the URL; filter and unresolved creation belong to this visit.

import { Plus } from "lucide-react";
import { useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import CollectionExhaustionNotice from "@/components/collections/CollectionExhaustionNotice";
import CollectionView from "@/components/collections/CollectionView";
import { FeedbackNotice, type FeedbackContent } from "@/components/feedback/Feedback";
import LibraryInvitations from "@/components/libraries/LibraryInvitations";
import Button from "@/components/ui/Button";
import PaneFilterRowsStatus from "@/components/workspace/PaneFilterRowsStatus";
import PaneQueryToolbar from "@/components/workspace/PaneQueryToolbar";
import { usePaneQueryInput } from "@/components/workspace/usePaneQueryInput";
import { isApiError } from "@/lib/api/client";
import { useChangeStamp } from "@/lib/api/changes";
import { useThrowLater } from "@/lib/api/serverState";
import {
  listRowStatus,
  pageQuery,
  useServerList,
  type ListSnapshot,
} from "@/lib/api/useServerList";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { libraryDisplayName, presentLibrary } from "@/lib/collections/presenters/library";
import { viewHref, type ViewChanges } from "@/lib/collections/view";
import { isAbortError } from "@/lib/errors";
import { createLibrary, librariesPage, type Library } from "@/lib/libraries/api";
import { libraryErrorFeedback, throwDefect } from "@/lib/libraries/errors";
import { INDEX_SORTS, RESERVED_NAME, isReservedName, offered } from "@/lib/libraries/views";
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
  usePaneSearchParams,
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

const VISIT = definePaneVisitDataKey<ListSnapshot<Library>>("Libraries.Index");
const CREATION_VISIT = definePaneVisitDataKey<Attempt>("Libraries.Creation");
const FILTER_VISIT = definePaneVisitDataKey<string>("Libraries.Filter");
const CREATE_DEADLINE_MS = 30_000;
const UNCONFIRMED: FeedbackContent = {
  tone: "Warning",
  title: "creation not confirmed",
  message: "this library may already exist. retry before creating another library.",
};
const UNIT = { singular: "library", plural: "libraries" };

function nameFeedback(name: string): DraftFeedback | null {
  if (name.length === 0)
    return { tone: "Danger", title: "enter a library name.", nameInvalid: true };
  if (Array.from(name).length > 100)
    return { tone: "Danger", title: "use 100 characters or fewer.", nameInvalid: true };
  if (isReservedName(name))
    return { tone: "Danger", title: RESERVED_NAME, nameInvalid: true };
  return null;
}

export default function LibrariesPaneBody() {
  const runtime = requirePaneRuntime(usePaneRuntime(), "LibrariesPaneBody");
  const router = runtime.router;
  const isActive = usePaneIsActive();
  const params = usePaneSearchParams();
  const sort = params.get("sort");
  const query = sort === null ? "" : new URLSearchParams({ sort }).toString();
  const list = useServerList<Library>({
    key: `/libraries?${query}`,
    stale: useChangeStamp("Libraries"),
    pageSize: 100,
    drain: true,
    active: isActive,
    visit: VISIT,
    id: (library) => library.id,
    fetchPage: (cursor, limit, signal) =>
      librariesPage(pageQuery(query, cursor, limit), signal),
  });
  const invalid =
    list.failure?.op === "Load" && list.failure.error.code === "E_INVALID_REQUEST";
  usePaneReturnReady(list.status !== "loading" || invalid);
  const scroll = usePaneScrollRetention(list.items);

  const fail = useThrowLater();
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
  const openCreatedLibrary = (library: Library) => {
    skipCreationReturnFocus.current = true;
    creationOpenRef.current = false;
    setCreationOpen(false);
    runtime.router.push(`/libraries/${encodeURIComponent(library.id)}`, {
      labelHint: libraryDisplayName(library),
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
      const library = await createLibrary({ id: attempt.libraryId, name: attempt.name }, signal);
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
            const failure = libraryErrorFeedback(error, "library wasn’t created", throwDefect);
            if (failure === null) return;
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
            const failure = libraryErrorFeedback(error, UNCONFIRMED.title, throwDefect);
            if (failure === null) return;
            transitionCreation({
              kind: "Unconfirmed",
              attempt,
              feedback: { ...failure, ...UNCONFIRMED },
            });
            break;
          }
          case "E_WIRE_MISMATCH":
            // The API requests a reload; the pane boundary owns a blocked reload.
            throw error;
          default:
            // justify-defect: every expected create refusal/transport outcome is handled above.
            throw error;
        }
      } catch (caught) {
        fail({ error: caught });
      }
    } finally {
      if (ownsDelivery()) delivery.current = null;
    }
  };

  const restoredFilter: string | null = usePaneVisitData(FILTER_VISIT, (): string => filter);
  const [filter, setFilter] = useState<string>(restoredFilter ?? "");
  const clearFilter = useCallback(() => setFilter(""), []);
  const rowStatus = listRowStatus(
    list,
    list.items.length,
    list.items.filter((library) =>
      matchesPaneFilterQuery(filter, [libraryDisplayName(library)]),
    ).length,
    UNIT,
  );
  const text = filter.trim();
  const change = useCallback(
    (changes: ViewChanges) => {
      scroll();
      router.replace(viewHref("/libraries", params, changes), {
        viewTransition: { kind: "collection-reflow" },
      });
    },
    [params, router, scroll],
  );
  const { inputRef, focusInput } = usePaneQueryInput();
  const queryStatusId = useId();
  const reset = () => {
    clearFilter();
    // Leaving an invalid view mounts the list: nothing to reflow, and a view
    // transition would mount it after the focus below.
    if (invalid) router.replace("/libraries");
    else change({ sort: null });
    requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
  };
  const { refetch } = list;
  const execute = useCallback<PaneRefreshExecute>(async () => {
    try {
      await refetch();
      return { kind: "Complete", announcement: "Libraries refreshed" };
    } catch {
      return { kind: "Failed", announcement: "Libraries failed to refresh" };
    }
  }, [refetch]);
  usePaneChrome({
    primaryAction: {
      id: "Libraries.Create",
      label: "new library",
      shortLabel: "new",
      icon: <Plus size={16} aria-hidden="true" />,
      onSelect: ({ triggerEl }) => openCreation(triggerEl),
    },
    query: invalid ? undefined : {
      kind: "Controls",
      label: "Filter libraries",
      focusInput,
      content: (
        <PaneQueryToolbar
          inputRef={inputRef}
          input={{ label: "Filter libraries", placeholder: "Filter libraries", value: filter, appliedValue: filter, onChange: (next) => setFilter(truncatePaneSearchQuery(next)), onClear: clearFilter }}
          sort={{ label: "Sort", value: sort ?? "", choices: offered(INDEX_SORTS, sort ?? ""), onChange: (value) => change({ sort: value || null }) }}
          status={{ id: queryStatusId, content: <PaneFilterRowsStatus id={queryStatusId} status={rowStatus} query={filter} /> }}
          onReset={sort || text ? reset : undefined}
        />
      ),
    },
    refresh: { kind: "Refreshable", sourceKey: "Libraries.Index", execute },
    header: {
      kind: "Section",
      // The count describes the complete view, never a subset.
      meta: invalid
        ? { kind: "None" }
        : list.complete
          ? { kind: "Count", value: list.items.length, unit: "library" }
          : { kind: "Pending" },
    },
  });

  const loadFailure =
    list.failure !== null && list.failure.op !== "More" && !invalid ? (
      <FeedbackNotice
        content={
          libraryErrorFeedback(
            list.failure.error,
            list.status === "ready"
              ? "Libraries couldn’t be refreshed"
              : "Libraries couldn’t be loaded",
            throwDefect,
          ) ?? { tone: "Danger", title: "Libraries couldn’t be loaded" }
        }
        announcement="Assertive"
        actions={[{ label: "Retry", onClick: list.retry }]}
      />
    ) : null;
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
          actions={[{ label: "Reset view", onClick: reset }]}
        />
      ) : (
        <>
          <LibraryInvitations />
          <CollectionView
            returnScope="Libraries.Items"
            rows={list.items
              .map(presentLibrary)
              .filter((row) => matchesPaneFilterQuery(text, [row.title.text]))}
            status={list.status === "failed" ? "error" : list.status}
            ariaLabel="Libraries"
            rowChangePresentation={{ kind: "ImmediateOnKeyChange", key: text }}
            collectionBusy={list.running !== null || !list.current}
            error={loadFailure}
            empty={
              <FeedbackNotice
                content={
                  text
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
              <>
                <CollectionExhaustionNotice list={list} />
                {loadFailure}
              </>
            }
          />
        </>
      )}
    </>
  );
}
