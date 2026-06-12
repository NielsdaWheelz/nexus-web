"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus } from "lucide-react";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import PaneSurface from "@/components/ui/PaneSurface";
import ResourceList from "@/components/ui/ResourceList";
import ResourceRow from "@/components/ui/ResourceRow";
import { FeedbackNotice, toFeedback, type FeedbackContent } from "@/components/feedback/Feedback";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { notePagesResource, type NoResourceParams } from "@/lib/api/resource";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { usePaneRouter, useSetPaneTitle } from "@/lib/panes/paneRuntime";
import { createNotePage, fetchNotePages, type NotePageSummary } from "@/lib/notes/api";
import { setPendingNoteFocus } from "@/lib/notes/pendingNoteFocus";
import { useResource } from "@/lib/api/useResource";
import styles from "./notes.module.css";

export default function NotesPaneBody() {
  const router = usePaneRouter();
  const [pages, setPages] = useState<NotePageSummary[]>([]);
  const [title, setTitle] = useState("");
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);
  const pagesResource = useResource<NotePageSummary[], NoResourceParams>({
    descriptor: notePagesResource,
    params: {},
    load: () => fetchNotePages(),
  });
  const loading = pagesResource.status === "loading" && pages.length === 0;

  useSetPaneTitle("Notes");

  useEffect(() => {
    if (pagesResource.status === "ready") {
      setPages(pagesResource.data);
      setFeedback(null);
      return;
    }

    if (pagesResource.status === "error") {
      setFeedback(toFeedback(pagesResource.error, { fallback: "Notes could not be loaded." }));
    }
  }, [pagesResource]);

  const createPage = useCallback(async () => {
    const trimmedTitle = title.trim();
    const nextTitle = trimmedTitle || "Untitled";
    try {
      const page = await createNotePage({ title: nextTitle });
      setPages((current) => [
        {
          id: page.id,
          title: page.title,
          description: page.description,
          documentVersion: page.documentVersion,
          updatedAt: page.updatedAt,
        },
        ...current,
      ]);
      setTitle("");
      setPendingNoteFocus({ pageId: page.id, target: trimmedTitle ? "body" : "title" });
      router.push(`/pages/${page.id}`);
    } catch (error: unknown) {
      if (handleUnauthenticatedApiError(error)) return;
      setFeedback(toFeedback(error, { fallback: "Page could not be created." }));
    }
  }, [router, title]);

  return (
    <PaneSurface
      toolbar={
      <form
        className={styles.toolbar}
        onSubmit={(event) => {
          event.preventDefault();
          void createPage();
        }}
      >
        <Input
          value={title}
          onChange={(event) => setTitle(event.currentTarget.value)}
          placeholder="New page"
          aria-label="New page title"
          style={{ flex: 1 }}
        />
        <Button iconOnly type="submit" aria-label="Create page">
          <Plus size={16} aria-hidden="true" />
        </Button>
      </form>
      }
      state={
        feedback || loading ? (
        <>
          {feedback ? <FeedbackNotice {...feedback} /> : null}
          {loading ? <PaneLoadingState /> : null}
        </>
        ) : null
      }
    >
      {pages.length > 0 ? (
        <ResourceList>
        {pages.map((page) => (
          <ResourceRow
            key={page.id}
            primary={{
              kind: "link",
              href: `/pages/${page.id}`,
              paneTitleHint: page.title,
            }}
            title={page.title}
            description={page.description}
          />
        ))}
        </ResourceList>
      ) : null}
    </PaneSurface>
  );
}
