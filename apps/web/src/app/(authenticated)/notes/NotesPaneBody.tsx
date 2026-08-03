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
import SectionOpener from "@/components/ui/SectionOpener";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import { notePagesResource, type NoResourceParams } from "@/lib/api/resource";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  requirePaneRuntime,
  usePaneReturnReady,
  usePaneRuntime,
  useSetPaneLabel,
} from "@/lib/panes/paneRuntime";
import { createNotePage } from "@/lib/notes/api";
import { useOpenDailyPage } from "@/lib/notes/openDailyPage";
import { PROGRAMMATIC_NEXUS_TARGET_ACTIVATION } from "@/lib/nexus/dispatch";
import type { NotePageSummary } from "@/lib/notes/normalize";
import { setPendingNoteFocus } from "@/lib/notes/pendingNoteFocus";
import { clientResourceFetcher } from "@/lib/api/resourceTransport.client";
import { useResource } from "@/lib/api/useResource";
import { paneResourceLoaders } from "@/lib/panes/paneResourceLoaders";
import { matchesPaneFilterQuery } from "@/lib/panes/paneRowFilter";
import usePaneFilterRows from "@/lib/panes/usePaneFilterRows";
import { presentNote } from "@/lib/collections/presenters/note";
import { useHydrationPreservedInput } from "@/lib/ui/useHydrationPreservedInput";
import styles from "./notes.module.css";

const EMPTY_NOTE_PAGES: readonly NotePageSummary[] = [];

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
  const [localPages, setLocalPages] = useState<NotePageSummary[] | null>(null);
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
  const pagesResource = useResource<NotePageSummary[], NoResourceParams>({
    descriptor: notePagesResource,
    params: {},
    load: (params, signal) =>
      paneResourceLoaders.notes!.load(
        clientResourceFetcher(signal),
        params,
      ) as Promise<NotePageSummary[]>,
  });
  usePaneReturnReady(
    pagesResource.status === "ready" || pagesResource.status === "error",
  );
  const resourcePages =
    pagesResource.status === "ready" ? pagesResource.data : null;
  const pages = localPages ?? resourcePages ?? EMPTY_NOTE_PAGES;
  const loading = pagesResource.status === "loading" && pages.length === 0;
  const getFilterStatus = useCallback(
    (query: string) => {
      const visibleCount = pages.filter((page) =>
        matchesPaneFilterQuery(query, [page.title]),
      ).length;
      const unit = { singular: "page", plural: "pages" };
      return pagesResource.status === "ready"
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
    [pages, pagesResource.status],
  );
  const { query: filterQuery, publication: search } = usePaneFilterRows({
    sourceKey: "Notes.Pages",
    inputLabel: "Filter pages",
    placeholder: "Filter pages",
    getRowStatus: getFilterStatus,
    activeDomainControlCount: 0,
  });
  const filteredPages = useMemo(
    () =>
      pages.filter((page) => matchesPaneFilterQuery(filterQuery, [page.title])),
    [filterQuery, pages],
  );

  useSetPaneLabel("Notes");
  usePanePrimaryChrome({
    search,
    header: {
      kind: "section",
      folio:
        pagesResource.status === "ready"
          ? { kind: "count", value: pages.length, unit: "page" }
          : { kind: "none" },
      pending: pagesResource.status === "loading",
    },
  });

  useEffect(() => {
    if (pagesResource.status === "ready") {
      setLocalPages(pagesResource.data);
    }
  }, [pagesResource]);

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
      setLocalPages((current) => [page, ...(current ?? resourcePages ?? [])]);
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
  }, [activateTarget, captureFailure, resourcePages, setTitle]);

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

  const loadFeedback =
    pagesResource.status === "error"
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
    <CollectionView
      returnScope="Notes.Pages"
      rows={filteredPages.map((page) => presentNote(page))}
      status={loading ? "loading" : "ready"}
      ariaLabel="Notes"
      rowChangePresentation={{
        kind: "ImmediateOnKeyChange",
        key: filterQuery.trim(),
      }}
      opener={<SectionOpener heading="Notes" />}
      notice={
        visibleFeedback ? (
          <FeedbackNotice
            content={visibleFeedback.content}
            announcement="Assertive"
            actions={visibleFeedback.actions}
          />
        ) : filterQuery.trim() &&
          pagesResource.status !== "ready" &&
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
                pagesResource.status === "ready"
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
  );
}
