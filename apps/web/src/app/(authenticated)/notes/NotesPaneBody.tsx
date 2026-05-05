"use client";

import { useCallback, useEffect, useState, type MouseEvent } from "react";
import { Plus } from "lucide-react";
import { FeedbackNotice, toFeedback, type FeedbackContent } from "@/components/feedback/Feedback";
import { usePaneRouter, useSetPaneTitle } from "@/lib/panes/paneRuntime";
import { createNotePage, fetchNotePages, type NotePageSummary } from "@/lib/notes/api";
import styles from "./notes.module.css";

export default function NotesPaneBody() {
  const router = usePaneRouter();
  const [pages, setPages] = useState<NotePageSummary[]>([]);
  const [title, setTitle] = useState("");
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);
  const [loading, setLoading] = useState(true);

  useSetPaneTitle("Notes");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchNotePages()
      .then((items) => {
        if (!cancelled) setPages(items);
      })
      .catch((error: unknown) => {
        if (!cancelled) setFeedback(toFeedback(error, { fallback: "Notes could not be loaded." }));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const createPage = useCallback(async () => {
    const nextTitle = title.trim() || "Untitled";
    try {
      const page = await createNotePage({ title: nextTitle });
      setPages((current) => [{ id: page.id, title: page.title, description: page.description, updatedAt: page.updatedAt }, ...current]);
      setTitle("");
      router.push(`/pages/${page.id}`);
    } catch (error: unknown) {
      setFeedback(toFeedback(error, { fallback: "Page could not be created." }));
    }
  }, [router, title]);

  const openPage = useCallback(
    (event: MouseEvent<HTMLAnchorElement>, href: string) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }

      event.preventDefault();
      router.push(href);
    },
    [router]
  );

  return (
    <div className={styles.shell}>
      <form
        className={styles.toolbar}
        onSubmit={(event) => {
          event.preventDefault();
          void createPage();
        }}
      >
        <input
          className={styles.input}
          value={title}
          onChange={(event) => setTitle(event.currentTarget.value)}
          placeholder="New page"
          aria-label="New page title"
        />
        <button className={styles.button} type="submit" aria-label="Create page">
          <Plus size={16} aria-hidden="true" />
        </button>
      </form>

      {feedback ? <FeedbackNotice {...feedback} /> : null}
      {loading ? <FeedbackNotice severity="info" title="Loading notes..." /> : null}

      <div className={styles.pageList}>
        {pages.map((page) => (
          <a
            key={page.id}
            className={styles.pageLink}
            href={`/pages/${page.id}`}
            onClick={(event) => openPage(event, `/pages/${page.id}`)}
          >
            <span className={styles.pageTitle}>{page.title}</span>
            {page.description ? <span className={styles.pageDescription}>{page.description}</span> : null}
          </a>
        ))}
      </div>
    </div>
  );
}
