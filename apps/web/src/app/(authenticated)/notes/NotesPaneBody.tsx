"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus } from "lucide-react";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import { FeedbackNotice, toFeedback, type FeedbackContent } from "@/components/feedback/Feedback";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { usePaneRouter, useSetPaneTitle } from "@/lib/panes/paneRuntime";
import { createNotePage, fetchNotePages, type NotePageSummary } from "@/lib/notes/api";
import { useResource } from "@/lib/api/useResource";
import styles from "./notes.module.css";

export default function NotesPaneBody() {
  const router = usePaneRouter();
  const [pages, setPages] = useState<NotePageSummary[]>([]);
  const [title, setTitle] = useState("");
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);
  const pagesResource = useResource<NotePageSummary[]>({
    cacheKey: "notes:pages",
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
    const nextTitle = title.trim() || "Untitled";
    try {
      const page = await createNotePage({ title: nextTitle });
      setPages((current) => [
        {
          id: page.id,
          title: page.title,
          description: page.description,
          revision: page.revision,
          updatedAt: page.updatedAt,
        },
        ...current,
      ]);
      setTitle("");
      router.push(`/pages/${page.id}`);
    } catch (error: unknown) {
      setFeedback(toFeedback(error, { fallback: "Page could not be created." }));
    }
  }, [router, title]);

  return (
    <div className={styles.shell}>
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

      {feedback ? <FeedbackNotice {...feedback} /> : null}
      {loading ? <PaneLoadingState /> : null}

      <div className={styles.pageList}>
        {pages.map((page) => (
          <a
            key={page.id}
            className={styles.pageLink}
            href={`/pages/${page.id}`}
            data-pane-title-hint={page.title}
          >
            <span className={styles.pageTitle}>{page.title}</span>
            {page.description ? <span className={styles.pageDescription}>{page.description}</span> : null}
          </a>
        ))}
      </div>
    </div>
  );
}
