"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import CollectionView from "@/components/collections/CollectionView";
import SectionOpener from "@/components/ui/SectionOpener";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import { notePagesResource, type NoResourceParams } from "@/lib/api/resource";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  requirePaneRuntime,
  usePaneReturnReady,
  usePaneRuntime,
  useSetPaneLabel,
} from "@/lib/panes/paneRuntime";
import { createNotePage } from "@/lib/notes/api";
import { openTodayPage } from "@/lib/notes/openToday";
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

export default function NotesPaneBody() {
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
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);
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
      setFeedback(null);
      return;
    }
    if (pagesResource.status === "error") {
      setFeedback(
        toFeedback(pagesResource.error, {
          fallback: "Notes could not be loaded.",
        }),
      );
    }
  }, [pagesResource]);

  const openToday = useCallback(async () => {
    try {
      await openTodayPage(PROGRAMMATIC_NEXUS_TARGET_ACTIVATION);
    } catch (error: unknown) {
      if (handleUnauthenticatedApiError(error)) return;
      setFeedback(toFeedback(error, { fallback: "Could not open today." }));
    }
  }, []);

  const createPage = useCallback(async () => {
    const trimmedTitle = title.trim();
    const nextTitle = trimmedTitle || "Untitled";
    const replay =
      pageCreateReplayRef.current?.title === nextTitle
        ? pageCreateReplayRef.current
        : { pageId: crypto.randomUUID(), title: nextTitle };
    pageCreateReplayRef.current = replay;
    try {
      const page = await createNotePage(replay);
      pageCreateReplayRef.current = null;
      setLocalPages((current) => [page, ...(current ?? resourcePages ?? [])]);
      setTitle("");
      setPendingNoteFocus({
        pageId: page.id,
        target: trimmedTitle ? "body" : "title",
      });
      activateTarget({
        target: { href: `/pages/${page.id}`, labelHint: page.title },
        disposition: { kind: "Follow" },
      });
    } catch (error: unknown) {
      if (handleUnauthenticatedApiError(error)) return;
      setFeedback(
        toFeedback(error, { fallback: "Page could not be created." }),
      );
    }
  }, [activateTarget, resourcePages, setTitle, title]);

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
        feedback ? (
          <FeedbackNotice feedback={feedback} />
        ) : filterQuery.trim() &&
          pagesResource.status !== "ready" &&
          filteredPages.length === 0 ? (
          <FeedbackNotice
            severity="neutral"
            title="No matching page found so far."
          />
        ) : undefined
      }
      empty={
        feedback ? undefined : filterQuery.trim() ? (
          <FeedbackNotice
            severity="neutral"
            title={
              pagesResource.status === "ready"
                ? "No pages match this filter."
                : "No matching page found so far."
            }
          />
        ) : (
          <FeedbackNotice severity="neutral">No pages yet.</FeedbackNotice>
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
            onClick={() => void openToday()}
          >
            Today
          </Button>
        </>
      }
    />
  );
}
