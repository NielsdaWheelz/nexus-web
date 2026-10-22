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
import { acquisitionGuard, libraryDestinations, type AcquisitionGuard, type LibraryDestination } from "@/lib/libraries/api";
import { formatLocalDateInTimeZone } from "@/lib/localDate";
import { captureToday } from "@/lib/notes/api";
import { APP_AUTHENTICATED_HOME_HREF } from "@/lib/routes/defaults";
import styles from "./share.module.css";

type Result =
  | { label: string; ok: true; status: string; path: string; available: boolean }
  | { label: string; ok: false; retryable: boolean; review: boolean; feedback: FeedbackContent };

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
    return { label, ok: false, retryable: false, review: false, feedback };
  }
  const feedback = describe();
  if (feedback === null) throw error;
  return { label, ok: false, retryable: true, review: isApiError(error) && ["E_RESOURCE_CONFLICT", "E_LIBRARY_FORBIDDEN"].includes(error.code), feedback };
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
  const commands = useRef(new Map<string, { id: string; guard: AcquisitionGuard }>());
  const [reviewUrls, setReviewUrls] = useState<readonly string[] | null>(null);
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
    setSaving(true);
    captureToday(localDate, noteId, trimmed).then(
      () =>
        setResults([
          {
            label: trimmed,
            ok: true,
            available: true,
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
    ).finally(() => setSaving(false));
  }, [plainText, timeZone, attempt, trimmed]);

  if (defect !== null) throw defect.error;

  async function saveUrl(url: string): Promise<Result> {
    const command = commands.current.get(url);
    if (command === undefined) throw new Error("share submission has no frozen acquisition command");
    try {
      const accepted = await addMediaFromUrl({ url, ...command });
      return {
        label: url,
        ok: true,
        available: accepted.available,
        status: captureStatusLine(accepted),
        path: accepted.href,
      };
    } catch (error) {
      if (isApiError(error) && error.status >= 400 && error.status < 500 && error.status !== 401) commands.current.delete(url);
      return failed(url, error, () =>
        captureErrorFeedback(error, "SaveSource"),
      );
    }
  }

  async function save(targets: readonly string[]): Promise<void> {
    if (saving || creating) return;
    setSaving(true);
    setReviewUrls(null);
    try {
      if (targets.some(url => !commands.current.has(url))) {
        const snapshot = await libraryDestinations();
        for (const url of targets) if (!commands.current.has(url)) commands.current.set(url, { id: crypto.randomUUID(), guard: acquisitionGuard(destinations, snapshot.removal_revision) });
      }
    } catch (error) {
      setResults(targets.map(url => failed(url, error, () => captureErrorFeedback(error, "SaveSource"))));
      setSaving(false);
      return;
    }
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

  if (urls.length > 0 && (results === null || reviewUrls !== null) && !saving) {
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
            onClick={() => void save(reviewUrls ?? urls)}
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
        <FeedbackState content={{ tone: "Neutral", title: "saving to nexus…", message: "capturing what you shared." }} announcement="Polite" />
      </>
    );
  }

  const retry = (result: Result) => {
    if (saving) return;
    if (urls.length > 0 && !result.ok && result.review) {
      setSaving(true);
      void libraryDestinations().then(snapshot => {
        const current = new Map(snapshot.destinations.map(destination => [destination.id, destination]));
        setDestinations(selected => selected.map(destination => current.get(destination.id) ?? destination));
        setReviewUrls([result.label]);
      }, error => setDefect({ error })).finally(() => setSaving(false));
    } else if (urls.length > 0) void save([result.label]);
    else if (account.status === "failed") account.refetch();
    else {
      setSaving(true);
      setAttempt((n) => n + 1);
    }
  };
  const anySaved = shown.some((result) => result.ok && result.available);
  const signedOut = shown.some((result) => !result.ok && !result.retryable);
  return (
    <>
      <h1 className={styles.heading}>
        {anySaved
          ? "Saved to Nexus"
          : shown.some(result => result.ok) ? "this item was saved, then removed"
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
                actions={result.available ? [{ label: result.path.startsWith("/daily/") ? "open" : "open in nexus", href: open(result.path) }] : undefined}
              />
            ) : (
              <FeedbackNotice
                content={result.feedback}
                announcement="Assertive"
                actions={result.retryable ? [{ label: result.review ? "review and save" : "check save", onClick: () => retry(result), busy: saving || account.status === "failed" && account.retrying }] : undefined}
                returnFocus={() => resultArea.current}
              />
            )}
          </div>
        ))}
      </div>
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
