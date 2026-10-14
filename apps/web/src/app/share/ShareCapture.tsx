"use client";

// The Android share sheet's capture card (`/share?text=`). Links get their list,
// a destination field (create allowed) and Save; each link is saved under its
// own id, kept for the page's life, so Retry resends the same acceptance. Plain
// text is appended to today's daily note once per attempt, under a date and a
// note id fixed on first send. Results offer Open (in the shell, through
// `nexus-share://open`) and Done.

import { useEffect, useMemo, useRef, useState } from "react";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import DestinationField from "@/components/libraries/DestinationField";
import {
  apiFetch,
  apiTransportFeedback,
  isApiError,
  isUnauthenticatedApiError,
} from "@/lib/api/client";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import type { ApiJson } from "@/lib/api/wire";
import { runBoundedTasks } from "@/lib/async/runBoundedTasks";
import { extractUrls } from "@/lib/extractUrls";
import { captureErrorFeedback, captureStatusLine } from "@/lib/imports/copy";
import { addMediaFromUrl } from "@/lib/imports/ingest";
import { createLibrary, type LibraryDestination } from "@/lib/libraries/api";
import { formatLocalDateInTimeZone } from "@/lib/localDate";
import { captureToday } from "@/lib/notes/api";
import { APP_AUTHENTICATED_HOME_HREF } from "@/lib/routes/defaults";
import styles from "./share.module.css";

type Result =
  | { label: string; ok: true; status: string; path: string }
  | { label: string; ok: false; retryable: boolean; feedback: FeedbackContent };

/** A refusal as a result row: sign-out is final for this share; anything the
    surface does not model throws. */
function failed(
  label: string,
  error: unknown,
  describe: () => FeedbackContent | null,
): Result {
  if (isUnauthenticatedApiError(error)) {
    const feedback: FeedbackContent = {
      tone: "Danger",
      title: "Sign in to save this",
      message: "Open Nexus, sign in, then share again.",
      requestId: error.requestId,
    };
    return { label, ok: false, retryable: false, feedback };
  }
  const feedback = describe();
  if (feedback === null) throw error;
  return { label, ok: false, retryable: true, feedback };
}

/** The account read and the plain-text append model only a lost connection. */
function networkOnly(error: unknown): FeedbackContent | null {
  return isApiError(error) && error.code === "E_NETWORK"
    ? apiTransportFeedback(error, "Couldn’t save")
    : null;
}

export default function ShareCapture({
  text,
  isShell,
}: {
  text: string;
  isShell: boolean;
}) {
  const trimmed = text.trim();
  const urls = useMemo(() => extractUrls(trimmed), [trimmed]);
  const [results, setResults] = useState<Result[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [destinations, setDestinations] = useState<
    readonly LibraryDestination[]
  >([]);
  const [attempt, setAttempt] = useState(0);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const urlIds = useRef(new Map<string, string>());
  const createIds = useRef(new Map<string, string>());
  const note = useRef<{ localDate: string; noteId: string } | null>(null);
  const sentAttempt = useRef<number | null>(null);
  const plainText = trimmed !== "" && urls.length === 0;
  const account = usePaneFreeServerValue({
    key: plainText ? "/me" : null,
    stale: "",
    load: (signal) =>
      apiFetch<ApiJson<"/me", "get">>("/api/me", { signal }).then(
        (body) => body.data,
      ),
  });
  const timeZone =
    account.status === "ready" ? account.data.calendar_time_zone : null;

  // plain text: one append per attempt (the effect runs twice in development);
  // the date and note id are fixed on first send, so a retry lands once
  useEffect(() => {
    if (!plainText || timeZone === null || sentAttempt.current === attempt) {
      return;
    }
    sentAttempt.current = attempt;
    note.current ??= {
      localDate: formatLocalDateInTimeZone(new Date(), timeZone),
      noteId: crypto.randomUUID(),
    };
    const { localDate, noteId } = note.current;
    setResults(null);
    captureToday(localDate, noteId, trimmed).then(
      () =>
        setResults([
          {
            label: trimmed,
            ok: true,
            status: "Added to today",
            path: `/daily/${localDate}`,
          },
        ]),
      (error: unknown) => {
        try {
          setResults([failed(trimmed, error, () => networkOnly(error))]);
        } catch (thrown) {
          setDefect({ error: thrown });
        }
      },
    );
  }, [plainText, timeZone, attempt, trimmed]);

  if (defect !== null) throw defect.error;

  async function saveUrl(url: string): Promise<Result> {
    let id = urlIds.current.get(url);
    if (id === undefined) urlIds.current.set(url, (id = crypto.randomUUID()));
    try {
      const libraryIds = destinations.map((library) => library.id);
      const accepted = await addMediaFromUrl({ url, libraryIds, id });
      const path = `/media/${accepted.mediaId}`;
      return {
        label: url,
        ok: true,
        status: captureStatusLine(accepted),
        path,
      };
    } catch (error) {
      return failed(url, error, () =>
        captureErrorFeedback(error, "SaveSource"),
      );
    }
  }

  function save(targets: string[]): void {
    setSaving(true);
    runBoundedTasks({ items: targets, concurrency: 2, run: saveUrl })
      .then((outcomes) => {
        const settled = outcomes.map((outcome) => {
          if (outcome.kind === "Rejected") throw outcome.error;
          return outcome.value;
        });
        setResults((current) =>
          current === null
            ? settled
            : current.map(
                (result) =>
                  settled.find((next) => next.label === result.label) ?? result,
              ),
        );
      })
      .catch((error: unknown) => setDefect({ error }))
      .finally(() => setSaving(false));
  }

  /** One id per name for the page's life: a create whose answer was lost
      resends it and lands once. */
  async function createDestination(name: string): Promise<LibraryDestination> {
    const clean = name.trim();
    let id = createIds.current.get(clean);
    if (id === undefined)
      createIds.current.set(clean, (id = crypto.randomUUID()));
    setCreating(true);
    try {
      return await createLibrary({ id, name: clean });
    } finally {
      setCreating(false);
    }
  }

  const done = isShell ? "nexus-share://done" : APP_AUTHENTICATED_HOME_HREF;
  const open = (path: string) =>
    isShell ? `nexus-share://open?path=${encodeURIComponent(path)}` : path;

  if (trimmed === "") {
    return (
      <>
        <h1 className={styles.heading}>Nothing to share</h1>
        <p className={styles.body}>
          The shared text was empty, so there was nothing to save.
        </p>
        <div className={styles.actions}>
          <a className={styles.actionPrimary} href={done}>
            Done
          </a>
        </div>
      </>
    );
  }

  if (urls.length > 0 && results === null && !saving) {
    return (
      <>
        <h1 className={styles.heading}>Save to Nexus</h1>
        <div className={styles.results}>
          {urls.map((url) => (
            <div key={url} className={styles.resultItem}>
              <span className={styles.resultLabel} title={url}>
                {url}
              </span>
            </div>
          ))}
        </div>
        <DestinationField
          label="Library destinations"
          emptyLabel="No additional libraries"
          chosen={destinations}
          onChange={setDestinations}
          disabled={creating}
          onCreate={createDestination}
        />
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.actionPrimary}
            disabled={creating}
            onClick={() => save(urls)}
          >
            Save
          </button>
          <a
            className={styles.action}
            href={
              isShell ? "nexus-share://dismiss" : APP_AUTHENTICATED_HOME_HREF
            }
          >
            Cancel
          </a>
        </div>
      </>
    );
  }

  const shown =
    results ??
    (account.status === "failed"
      ? [failed(trimmed, account.error, () => networkOnly(account.error))]
      : null);
  if (shown === null || saving) {
    return (
      <>
        <h1 className={styles.heading}>Saving to Nexus…</h1>
        <p className={styles.body}>Capturing what you shared.</p>
      </>
    );
  }

  const retry = shown
    .filter((result) => !result.ok && result.retryable)
    .map((result) => result.label);
  const anySaved = shown.some((result) => result.ok);
  const signedOut = shown.some((result) => !result.ok && !result.retryable);
  return (
    <>
      <h1 className={styles.heading}>
        {anySaved
          ? "Saved to Nexus"
          : signedOut
            ? "Sign in to save this"
            : "Couldn’t save"}
      </h1>
      <div className={styles.results}>
        {shown.map((result) => (
          <div key={result.label} className={styles.resultItem}>
            <span className={styles.resultLabel} title={result.label}>
              {result.label}
            </span>
            {result.ok ? (
              <>
                <span className={styles.resultStatus}>{result.status}</span>
                <div className={styles.actions}>
                  <a className={styles.action} href={open(result.path)}>
                    {result.path.startsWith("/daily/")
                      ? "Open"
                      : "Open in Nexus"}
                  </a>
                </div>
              </>
            ) : (
              <>
                <span className={styles.error}>{result.feedback.title}</span>
                {result.feedback.message ? (
                  <span className={styles.resultStatus}>
                    {result.feedback.message}
                  </span>
                ) : null}
                {result.feedback.requestId ? (
                  <span className={styles.resultStatus}>
                    Nexus request ID: {result.feedback.requestId}
                  </span>
                ) : null}
              </>
            )}
          </div>
        ))}
      </div>
      <div className={styles.actions}>
        {retry.length > 0 ? (
          <button
            type="button"
            className={styles.actionPrimary}
            onClick={() =>
              urls.length > 0
                ? save(retry)
                : account.status === "failed"
                  ? account.refetch()
                  : setAttempt((n) => n + 1)
            }
          >
            Retry
          </button>
        ) : null}
        <a
          className={
            retry.length > 0 || !anySaved ? styles.action : styles.actionPrimary
          }
          href={done}
        >
          Done
        </a>
      </div>
    </>
  );
}
