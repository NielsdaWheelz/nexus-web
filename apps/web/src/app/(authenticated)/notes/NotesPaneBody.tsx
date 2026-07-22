"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus } from "lucide-react";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import { FeedbackNotice, toFeedback, type FeedbackContent } from "@/components/feedback/Feedback";
import CollectionView from "@/components/collections/CollectionView";
import SectionOpener from "@/components/ui/SectionOpener";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import { notePagesResource, type NoResourceParams } from "@/lib/api/resource";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { usePaneRouter, useSetPaneLabel } from "@/lib/panes/paneRuntime";
import { createNotePage } from "@/lib/notes/api";
import { openTodayPage } from "@/lib/notes/openToday";
import type { NotePageSummary } from "@/lib/notes/normalize";
import { setPendingNoteFocus } from "@/lib/notes/pendingNoteFocus";
import { clientResourceFetcher } from "@/lib/api/resourceTransport.client";
import { useResource } from "@/lib/api/useResource";
import { paneResourceLoaders } from "@/lib/panes/paneResourceLoaders";
import { presentNote } from "@/lib/collections/presenters/note";
import { useHydrationPreservedInput } from "@/lib/ui/useHydrationPreservedInput";
import styles from "./notes.module.css";

export default function NotesPaneBody() {
  const router = usePaneRouter();
  const [localPages, setLocalPages] = useState<NotePageSummary[] | null>(null);
  const {
    value: title,
    setValue: setTitle,
    inputProps: titleInputProps,
  } = useHydrationPreservedInput();
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);
  const pagesResource = useResource<NotePageSummary[], NoResourceParams>({
    descriptor: notePagesResource,
    params: {},
    load: (params, signal) =>
      paneResourceLoaders.notes!.load(
        clientResourceFetcher(signal),
        params,
      ) as Promise<NotePageSummary[]>,
  });
  const resourcePages =
    pagesResource.status === "ready" ? pagesResource.data : null;
  const pages = localPages ?? resourcePages ?? [];
  const loading = pagesResource.status === "loading" && pages.length === 0;

  useSetPaneLabel("Notes");
  usePanePrimaryChrome({
    header: {
      kind: "section",
      folio: { kind: "count", value: pages.length, unit: "page" },
      pending: loading,
    },
  });

  useEffect(() => {
    if (pagesResource.status === "ready") {
      setLocalPages(pagesResource.data);
      setFeedback(null);
      return;
    }
    if (pagesResource.status === "error") {
      setFeedback(toFeedback(pagesResource.error, { fallback: "Notes could not be loaded." }));
    }
  }, [pagesResource]);

  const openToday = useCallback(async () => {
    try {
      await openTodayPage();
    } catch (error: unknown) {
      if (handleUnauthenticatedApiError(error)) return;
      setFeedback(toFeedback(error, { fallback: "Could not open today." }));
    }
  }, []);

  const createPage = useCallback(async () => {
    const trimmedTitle = title.trim();
    const nextTitle = trimmedTitle || "Untitled";
    try {
      const page = await createNotePage({ title: nextTitle });
      setLocalPages((current) => [
        { id: page.id, title: page.title, updatedAt: page.updatedAt },
        ...(current ?? resourcePages ?? []),
      ]);
      setTitle("");
      setPendingNoteFocus({ pageId: page.id, target: trimmedTitle ? "body" : "title" });
      router.push(`/pages/${page.id}`);
    } catch (error: unknown) {
      if (handleUnauthenticatedApiError(error)) return;
      setFeedback(toFeedback(error, { fallback: "Page could not be created." }));
    }
  }, [resourcePages, router, setTitle, title]);

  return (
    <CollectionView
      rows={pages.map((page) => presentNote(page))}
      status={loading ? "loading" : "ready"}
      ariaLabel="Notes"
      opener={<SectionOpener heading="Notes" />}
      notice={feedback ? <FeedbackNotice feedback={feedback} /> : undefined}
      empty={feedback ? undefined : <FeedbackNotice severity="neutral">No pages yet.</FeedbackNotice>}
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
