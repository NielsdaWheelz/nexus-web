"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import {
  FeedbackNotice,
  type FeedbackActions,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import CollectionView from "@/components/collections/CollectionView";
import SelectField from "@/components/ui/SelectField";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import { notePagesResource } from "@/lib/api/resource";
import { apiFetch, isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { usePaneUrlState } from "@/lib/api/usePaneUrlState";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  requirePaneRuntime,
  usePaneReturnReady,
  usePaneRuntime,
  useSetPaneLabel,
} from "@/lib/panes/paneRuntime";
import { createNotePage } from "@/lib/notes/api";
import { useOpenDailyPage } from "@/lib/notes/openDailyPage";
import {
  CANONICAL_NOTES_INDEX_VIEW,
  NOTES_SORT_OPTION_IDS,
  decodeNotesIndexView,
  encodeNotesIndexView,
  notesSortOptionLabel,
  notesSortOptionOf,
  notesViewForSortOption,
  type DecodedNotesIndexView,
  type NotesIndexView,
  type NotesSortOptionId,
} from "@/lib/notes/pageIndexView";
import { PROGRAMMATIC_NEXUS_TARGET_ACTIVATION } from "@/lib/nexus/dispatch";
import { normalizePageSummary, type NotePageSummary } from "@/lib/notes/normalize";
import { setPendingNoteFocus } from "@/lib/notes/pendingNoteFocus";
import { useResource } from "@/lib/api/useResource";
import { matchesPaneFilterQuery } from "@/lib/panes/paneRowFilter";
import usePaneFilterRows from "@/lib/panes/usePaneFilterRows";
import usePaneScrollRetention from "@/lib/panes/usePaneScrollRetention";
import { presentNote } from "@/lib/collections/presenters/note";
import { useHydrationPreservedInput } from "@/lib/ui/useHydrationPreservedInput";
import styles from "./notes.module.css";

const EMPTY_NOTE_PAGES: readonly NotePageSummary[] = [];

/** The index committed as one exact view. The endpoint is exhaustive. */
interface CommittedPagesView {
  readonly view: NotesIndexView;
  readonly pages: readonly NotePageSummary[];
}

// The one code that turns a request failure into the "Invalid pages view"
// terminal state: the backend rejects a view it does not advertise with it.
function isInvalidViewError(error: unknown): boolean {
  return isApiError(error) && error.code === "E_INVALID_REQUEST";
}

export type NotesOperation = "Load" | "CreatePage" | "OpenToday";

interface CreatePageIntent {
  readonly replay: { readonly pageId: string; readonly title: string };
  readonly focusTarget: "body" | "title";
}

function notesOperationTitle(operation: NotesOperation): string {
  switch (operation) {
    case "Load":
      return "Notes couldn’t be loaded";
    case "CreatePage":
      return "Page couldn’t be created";
    case "OpenToday":
      return "Today couldn’t be opened";
  }
}

/** Finite Notes-domain copy adapter; contract and unknown failures defect. */
export function notesErrorMessage(
  error: unknown,
  operation: NotesOperation,
): FeedbackContent {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;

  const title = notesOperationTitle(operation);
  const requestId = error.requestId;
  switch (error.code) {
    case "E_NETWORK":
      if (operation === "OpenToday") throw error;
      return {
        tone: "Danger",
        title,
        message: "Check your connection and retry.",
        requestId,
      };
    case "E_UPSTREAM":
    case "E_UPSTREAM_TIMEOUT":
      if (operation === "OpenToday") throw error;
      return {
        tone: "Danger",
        title,
        message: "Nexus couldn’t complete the request. Wait a moment, then retry.",
        requestId,
      };
    case "E_RATE_LIMITED":
      if (operation === "OpenToday") throw error;
      return {
        tone: "Danger",
        title,
        message: "Wait a moment, then retry.",
        requestId,
      };
    case "E_BAD_REQUEST":
    case "E_INVALID_REQUEST":
      if (operation !== "CreatePage") throw error;
      return {
        tone: "Danger",
        title,
        message: "Change the page title, then submit it again.",
        requestId,
      };
    case "E_RESOURCE_CONFLICT":
      if (operation !== "CreatePage") throw error;
      return {
        tone: "Danger",
        title,
        message:
          "The saved create request conflicts with another page. Change the title, then submit it again.",
        requestId,
      };
    default:
      throw error;
  }
}

export default function NotesPaneBody() {
  const openDailyPage = useOpenDailyPage();
  const activateTarget = requirePaneRuntime(
    usePaneRuntime(),
    "NotesPaneBody",
  ).activateTarget;
  const {
    value: title,
    setValue: setTitle,
    inputProps: titleInputProps,
  } = useHydrationPreservedInput();
  const [operationFeedback, setOperationFeedback] = useState<{
    content: FeedbackContent;
    retry: "CreatePage" | "OpenToday" | null;
  } | null>(null);
  const [failedCreateIntent, setFailedCreateIntent] =
    useState<CreatePageIntent | null>(null);
  const [defectState, setDefectState] = useState<{ error: unknown } | null>(null);
  const pageCreateReplayRef = useRef<{
    pageId: string;
    title: string;
  } | null>(null);

  // The pane URL owns the index view through a strict, total codec; `view` is
  // null only for an Invalid URL, a terminal, user-recoverable state.
  const pagesViewCodec = useMemo(
    () => ({
      basePath: "/notes",
      decode: decodeNotesIndexView,
      encode: (
        decoded: DecodedNotesIndexView,
        current: URLSearchParams,
      ): URLSearchParams =>
        encodeNotesIndexView(
          decoded.kind === "Valid" ? decoded.view : CANONICAL_NOTES_INDEX_VIEW,
          current,
        ),
      replaceOptions: {
        viewTransition: { kind: "collection-reflow" as const },
      },
    }),
    [],
  );
  const { state: decodedView, setState: setDecodedView } =
    usePaneUrlState(pagesViewCodec);
  const view = decodedView.kind === "Valid" ? decodedView.view : null;
  // Set when the backend rejects the requested view; cleared whenever another
  // view is requested.
  const [viewInvalid, setViewInvalid] = useState(false);
  const invalidView = decodedView.kind === "Invalid" || viewInvalid;
  const [committed, setCommitted] = useState<CommittedPagesView | null>(null);
  const listRegionRef = useRef<HTMLDivElement | null>(null);
  const capturePaneScroll = usePaneScrollRetention(listRegionRef, committed);
  const sortSelectRef = useRef<HTMLSelectElement | null>(null);
  // Set before a view replacement the user initiated from the sort control, so
  // the commit that answers it returns focus there.
  const pendingCommitFocusRef = useRef(false);
  const focusPendingSortControl = useCallback(() => {
    if (!pendingCommitFocusRef.current) return;
    pendingCommitFocusRef.current = false;
    const element = sortSelectRef.current;
    if (element === null) return;
    requestAnimationFrame(() => element.focus());
  }, []);
  // A view replacement only writes the URL: the committed rows stay rendered
  // until the requested/committed mismatch it creates is answered.
  const setView = useCallback(
    (next: NotesIndexView) => {
      capturePaneScroll();
      setDecodedView({ kind: "Valid", view: next });
    },
    [capturePaneScroll, setDecodedView],
  );

  const requestedViewKey =
    view === null ? null : notePagesResource.cacheKey({ view });
  const committedViewKey =
    committed === null
      ? null
      : notePagesResource.cacheKey({ view: committed.view });
  // The canonical view is the route's server seed (whose resource key this one
  // matches); every other exact view owns its own request. An invalid view
  // requests nothing at all.
  const requestsFirstPage =
    view === null ||
    committed === null ||
    requestedViewKey !== committedViewKey;
  const pagesResource = useResource<readonly NotePageSummary[]>({
    cacheKey: requestsFirstPage && !invalidView ? requestedViewKey : null,
    load: async (signal) => {
      if (view === null) {
        // justify-defect: a non-null request key is built from this exact view.
        throw new Error("Notes index request lost its view identity");
      }
      const envelope = await apiFetch<{
        data: { pages?: Record<string, unknown>[] };
      }>(notePagesResource.clientPath({ view }), { signal });
      return (envelope.data.pages ?? []).map(normalizePageSummary);
    },
  });
  // Latest-wins atomic commit: the resource reports a result only under the
  // current request identity, so a superseded view can never install its rows.
  useEffect(() => {
    if (pagesResource.status === "ready" && view !== null) {
      setCommitted({ view, pages: pagesResource.data });
      focusPendingSortControl();
      return;
    }
    if (
      pagesResource.status === "error" &&
      isInvalidViewError(pagesResource.error)
    ) {
      setViewInvalid(true);
    }
  }, [focusPendingSortControl, pagesResource, view]);
  // A newly requested view retires the previous view's rejection.
  useEffect(() => setViewInvalid(false), [requestedViewKey]);
  usePaneReturnReady(
    committed !== null || pagesResource.status === "error" || invalidView,
  );
  const pages = committed?.pages ?? EMPTY_NOTE_PAGES;
  const loading = committed === null && pagesResource.status !== "error";
  const getFilterStatus = useCallback(
    (query: string) => {
      const visibleCount = pages.filter((page) =>
        matchesPaneFilterQuery(query, [page.title]),
      ).length;
      const unit = { singular: "page", plural: "pages" };
      return committed !== null
        ? {
            kind: "Complete" as const,
            visibleCount,
            totalCount: pages.length,
            unit,
          }
        : {
            kind: "Partial" as const,
            visibleCount,
            loadedCount: pages.length,
            unit,
          };
    },
    [committed, pages],
  );
  const dismissFilterRowsRef = useRef<() => void>(() => undefined);
  const clearDomainFilters = useCallback(() => {
    dismissFilterRowsRef.current();
    pendingCommitFocusRef.current = true;
    setView(CANONICAL_NOTES_INDEX_VIEW);
  }, [setView]);
  const domainFilterControls = useMemo(
    () =>
      invalidView || view === null ? undefined : (
        <>
          <SelectField
            layout="Stacked"
            label="Sort by"
            ref={sortSelectRef}
            value={notesSortOptionOf(view)}
            onChange={(event) => {
              pendingCommitFocusRef.current = true;
              setView(
                notesViewForSortOption(
                  event.target.value as NotesSortOptionId,
                ),
              );
            }}
          >
            {NOTES_SORT_OPTION_IDS.map((optionId) => (
              <option key={optionId} value={optionId}>
                {notesSortOptionLabel(optionId)}
              </option>
            ))}
          </SelectField>
          {view.kind === "Canonical" ? null : (
            <Button variant="secondary" size="sm" onClick={clearDomainFilters}>
              Clear filters
            </Button>
          )}
        </>
      ),
    [clearDomainFilters, invalidView, setView, view],
  );
  const { query: filterQuery, publication: search } = usePaneFilterRows({
    sourceKey: "Notes.Pages",
    inputLabel: "Filter pages",
    placeholder: "Filter pages",
    getRowStatus: getFilterStatus,
    activeDomainControlCount:
      view === null || invalidView || view.kind === "Canonical" ? 0 : 1,
    filters: domainFilterControls,
  });
  dismissFilterRowsRef.current = search.onDismiss;
  const filteredPages = useMemo(
    () =>
      pages.filter((page) => matchesPaneFilterQuery(filterQuery, [page.title])),
    [filterQuery, pages],
  );

  useSetPaneLabel("Notes");
  usePanePrimaryChrome({
    search,
    header: {
      kind: "Section",
      // The metadata describes the exhaustive committed view, never the subset.
      meta:
        pagesResource.status === "loading"
          ? { kind: "Pending" }
          : committed !== null && !invalidView
            ? { kind: "Count", value: pages.length, unit: "page" }
            : { kind: "None" },
    },
  });

  const captureFailure = useCallback(
    (error: unknown, operation: NotesOperation): FeedbackContent | null => {
      if (handleUnauthenticatedApiError(error)) return null;
      try {
        return notesErrorMessage(error, operation);
      } catch (caughtDefect: unknown) {
        setDefectState({ error: caughtDefect });
        return null;
      }
    },
    [],
  );

  const viewToday = useCallback(() => {
    setOperationFeedback(null);
    try {
      openDailyPage(
        {
          kind: "OpenDailyPage",
          date: { kind: "Today" },
          entry: { kind: "View" },
        },
        PROGRAMMATIC_NEXUS_TARGET_ACTIVATION,
      );
    } catch (error: unknown) {
      const content = captureFailure(error, "OpenToday");
      if (content) {
        setOperationFeedback({ content, retry: "OpenToday" });
      }
    }
  }, [captureFailure, openDailyPage]);

  const attemptCreatePage = useCallback(async (intent: CreatePageIntent) => {
    setOperationFeedback(null);
    try {
      const page = await createNotePage(intent.replay);
      pageCreateReplayRef.current = null;
      setFailedCreateIntent(null);
      setCommitted((current) =>
        current === null
          ? current
          : { ...current, pages: [page, ...current.pages] },
      );
      setTitle("");
      setPendingNoteFocus({
        pageId: page.id,
        target: intent.focusTarget,
      });
      activateTarget({
        target: { href: `/pages/${page.id}`, labelHint: page.title },
        disposition: { kind: "Follow" },
      });
    } catch (error: unknown) {
      const content = captureFailure(error, "CreatePage");
      if (content) {
        const replayable =
          isApiError(error) &&
          (error.code === "E_NETWORK" ||
            error.code === "E_UPSTREAM" ||
            error.code === "E_UPSTREAM_TIMEOUT" ||
            error.code === "E_RATE_LIMITED");
        setFailedCreateIntent(replayable ? intent : null);
        if (!replayable) pageCreateReplayRef.current = null;
        setOperationFeedback({
          content,
          retry: replayable ? "CreatePage" : null,
        });
      }
    }
  }, [activateTarget, captureFailure, setTitle]);

  const createPage = useCallback(() => {
    const trimmedTitle = title.trim();
    const nextTitle = trimmedTitle || "Untitled";
    const replay =
      pageCreateReplayRef.current?.title === nextTitle
        ? pageCreateReplayRef.current
        : { pageId: crypto.randomUUID(), title: nextTitle };
    pageCreateReplayRef.current = replay;
    void attemptCreatePage({
      replay,
      focusTarget: trimmedTitle ? "body" : "title",
    });
  }, [attemptCreatePage, title]);

  const retryFailedCreate = useCallback(() => {
    if (failedCreateIntent) void attemptCreatePage(failedCreateIntent);
  }, [attemptCreatePage, failedCreateIntent]);

  if (defectState !== null) throw defectState.error;

  if (invalidView) {
    return (
      <FeedbackNotice
        content={{ tone: "Danger", title: "Invalid pages view" }}
        announcement="Assertive"
        actions={[
          {
            label: "Reset view",
            onClick: () => {
              search.onDismiss();
              setDecodedView({
                kind: "Valid",
                view: CANONICAL_NOTES_INDEX_VIEW,
              });
            },
          },
        ]}
      />
    );
  }

  // A rejected view is the terminal state above, not a load failure: the copy
  // adapter models neither, so it is never asked about one.
  const loadFeedback =
    pagesResource.status === "error" &&
    !isInvalidViewError(pagesResource.error)
      ? {
          content: notesErrorMessage(pagesResource.error, "Load"),
          actions: [
            { label: "Retry", onClick: pagesResource.retry },
          ] as FeedbackActions,
        }
      : null;
  const operationActions: FeedbackActions | undefined = operationFeedback
    ? operationFeedback.retry === "CreatePage"
      ? [{ label: "Retry", onClick: retryFailedCreate }]
      : operationFeedback.retry === "OpenToday"
        ? [{ label: "Retry", onClick: viewToday }]
        : undefined
    : undefined;
  const visibleFeedback = loadFeedback ??
    (operationFeedback
      ? { content: operationFeedback.content, actions: operationActions }
      : null);

  return (
    <div ref={listRegionRef}>
    <CollectionView
      returnScope="Notes.Pages"
      rows={filteredPages.map((page) => presentNote(page))}
      status={loading ? "loading" : "ready"}
      ariaLabel="Notes"
      rowChangePresentation={{
        kind: "ImmediateOnKeyChange",
        key: filterQuery.trim(),
      }}
      notice={
        visibleFeedback ? (
          <FeedbackNotice
            content={visibleFeedback.content}
            announcement="Assertive"
            actions={visibleFeedback.actions}
          />
        ) : filterQuery.trim() &&
          committed === null &&
          filteredPages.length === 0 ? (
          <FeedbackNotice
            content={{
              tone: "Neutral",
              title: "No matching page found so far.",
            }}
            announcement="None"
          />
        ) : undefined
      }
      empty={
        visibleFeedback ? undefined : filterQuery.trim() ? (
          <FeedbackNotice
            content={{
              tone: "Neutral",
              title:
                committed !== null
                  ? "No pages match this filter."
                  : "No matching page found so far.",
            }}
            announcement="None"
          />
        ) : (
          <FeedbackNotice
            content={{ tone: "Neutral", title: "No pages yet." }}
            announcement="None"
          />
        )
      }
      toolbar={
        <>
          <form
            className={styles.toolbar}
            onSubmit={(event) => {
              event.preventDefault();
              void createPage();
            }}
          >
            <Input
              {...titleInputProps}
              placeholder="New page"
              aria-label="New page title"
              style={{ flex: 1 }}
            />
            <Button iconOnly type="submit" aria-label="Create page">
              <Plus size={16} aria-hidden="true" />
            </Button>
          </form>
          <Button
            variant="secondary"
            size="sm"
            onClick={viewToday}
          >
            Today
          </Button>
        </>
      }
    />
    </div>
  );
}
