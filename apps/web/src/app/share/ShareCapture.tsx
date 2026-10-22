"use client";

// The Android share sheet's capture card (`/share?text=`). Links get their list,
// a destination field (create allowed) and Save; each link is saved under its
// own id, kept for the page's life, so Retry resends the same acceptance. Plain
// text is appended to today's daily note once per attempt, under a date and a
// note id fixed on first send. Results offer Open (in the shell, through
// `nexus-share://open`) and Done.

import { useEffect, useMemo, useRef, useState } from "react";
import { FeedbackNotice, FeedbackState, FeedbackStatus, type FeedbackContent } from "@/components/feedback/Feedback";
import DestinationField from "@/components/libraries/DestinationField";
import { setDestination } from "@/components/libraries/DestinationChooser";
import { createDestinationCreation, useDestinationCreation } from "@/components/libraries/useDestinationCreation";
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
import type { LibraryDestination } from "@/lib/libraries/api";
import { formatLocalDateInTimeZone } from "@/lib/localDate";
import { captureToday } from "@/lib/notes/api";
import { readWriting } from "@/lib/notes/journal";
import { useWritingRuntime } from "@/lib/notes/useWritingRuntime";
import { WritingStatus } from "@/components/notes/NoteNotices";
import { APP_AUTHENTICATED_HOME_HREF } from "@/lib/routes/defaults";
import { WorkProvider } from "@/lib/unsavedWork";
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

export default function ShareCapture(props: { text: string; isShell: boolean }) {
  return <WorkProvider><ShareCaptureContent {...props} /></WorkProvider>;
}

function ShareCaptureContent({
  text,
  isShell,
}: {
  text: string;
  isShell: boolean;
}) {
  const trimmed = text.trim();
  const urls = useMemo(() => extractUrls(trimmed), [trimmed]);
  const [results, setResults] = useState<Result[] | null>(null);
  const resultArea = useRef<HTMLDivElement>(null);
  const [saving, setSaving] = useState(false);
  const [destinationCreation] = useState(createDestinationCreation);
  const creation = useDestinationCreation(trimmed, destinationCreation);
  const creating = creation.creating;
  const [destinations, setDestinations] = useState<
    readonly LibraryDestination[]
  >([]);
  const [attempt, setAttempt] = useState(0);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const urlIds = useRef(new Map<string, string>());
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
  const writing = useWritingRuntime(account.status === "ready" ? account.data.user_id : null);

  // plain text: one append per attempt (the effect runs twice in development);
  // the date and note id are fixed on first send, so a retry lands once
  useEffect(() => {
    if (!plainText || writing.state !== "ready" || timeZone === null || sentAttempt.current === attempt) {
      return;
    }
    sentAttempt.current = attempt;
    note.current ??= {
      localDate: formatLocalDateInTimeZone(new Date(), timeZone),
      noteId: crypto.randomUUID(),
    };
    const { localDate, noteId } = note.current;
    let active = true;
    setSaving(true);
    captureToday(localDate, noteId, trimmed).then(
      ({ settled }) => {
        const result = (status: string): Result => ({ label: trimmed, ok: true, status, path: `/daily/${localDate}` });
        if (active) setResults([result(`kept on this device; queued for ${localDate}`)]);
        void settled.then(() => {
          if (active) setResults([result(`synced to ${localDate}`)]);
        }, () => {
          if (active) setResults([result("kept on this device; review this capture in notes")]);
        });
      },
      (error: unknown) => {
        if (!active) return;
        if (readWriting().storage_error !== null) {
          setResults([{ label: trimmed, ok: false, retryable: true, feedback: {
            tone: "Warning", title: "recent changes are only in this tab.", message: "keep it open or copy the shared text before leaving.",
          } }]);
          return;
        }
        try {
          setResults([failed(trimmed, error, () => networkOnly(error))]);
        } catch (thrown) {
          setDefect({ error: thrown });
        }
      },
    ).finally(() => { if (active) setSaving(false); });
    return () => { active = false; };
  }, [plainText, writing.state, timeZone, attempt, trimmed]);

  if (defect !== null) throw defect.error;

  async function saveUrl(url: string): Promise<Result> {
    let id = urlIds.current.get(url);
    if (id === undefined) urlIds.current.set(url, (id = crypto.randomUUID()));
    try {
      const libraryIds = destinations.map((library) => library.id);
      const accepted = await addMediaFromUrl({ url, libraryIds, id });
      return {
        label: url,
        ok: true,
        status: captureStatusLine(accepted),
        path: accepted.href,
      };
    } catch (error) {
      return failed(url, error, () =>
        captureErrorFeedback(error, "SaveSource"),
      );
    }
  }

  function save(targets: string[]): void {
    if (saving || creating) return;
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
          onSet={change => {
            if (saving) return false;
            setDestinations(current => setDestination(current, change));
            return true;
          }}
          disabled={saving}
          create={{ available: !saving, pendingNames: creation.pendingNames,
            onCreate: name => creation.admit({ name, scope: trimmed,
              onCreated: destination => setDestinations(current => setDestination(current, { destination, included: true })),
            }) }}
          error={creation.error}
          status={creation.status}
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
  if (shown === null) {
    return (
      <>
        {writing.state === "failed" ? (
          <FeedbackNotice content={{ tone: "Warning", title: "couldn’t start writing", message: "your shared text is kept here." }} announcement="Polite" actions={[{ label: "retry", onClick: writing.retry }]} />
        ) : <FeedbackState content={{ tone: "Neutral", title: "saving to nexus…", message: "capturing what you shared." }} announcement="Polite" />}
      </>
    );
  }

  const retry = (result: Result) => {
    if (saving) return;
    if (urls.length > 0) save([result.label]);
    else if (account.status === "failed") account.refetch();
    else {
      setSaving(true);
      setAttempt((n) => n + 1);
    }
  };
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
      <div className={styles.results} ref={resultArea} tabIndex={-1}>
        {shown.map((result) => (
          <div key={result.label} className={styles.resultItem}>
            <span className={styles.resultLabel} title={result.label}>
              {result.label}
            </span>
            {result.ok ? (
              <FeedbackStatus
                content={{ tone: "Neutral", title: result.status }}
                announcement="Polite"
                actions={[{ label: result.path.startsWith("/daily/") ? "open" : "open in nexus", href: open(result.path) }]}
              />
            ) : (
              <FeedbackNotice
                content={result.feedback}
                announcement="Assertive"
                actions={result.retryable ? [{ label: "retry", onClick: () => retry(result), busy: saving || account.status === "failed" && account.retrying }] : undefined}
                returnFocus={() => resultArea.current}
              />
            )}
          </div>
        ))}
      </div>
      {plainText ? <WritingStatus /> : null}
      <div className={styles.actions}>
        <a
          className={anySaved ? styles.actionPrimary : styles.action}
          href={done}
        >
          Done
        </a>
      </div>
    </>
  );
}
