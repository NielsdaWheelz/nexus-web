"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import LibraryDestinationPicker from "@/components/LibraryDestinationPicker";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import { isUnauthenticatedApiError } from "@/lib/api/client";
import { runBoundedTasks } from "@/lib/async/runBoundedTasks";
import { createRandomId } from "@/lib/createRandomId";
import { extractUrls } from "@/lib/extractUrls";
import {
  createLibrary,
  type LibraryDestinationSelection,
} from "@/lib/libraries/client";
import {
  captureSourceUrl,
  isSourceUrlCaptureDefect,
} from "@/lib/media/sourceUrlCapture";
import { quickCaptureDailyNote } from "@/lib/notes/api";
import { APP_AUTHENTICATED_HOME_HREF } from "@/lib/routes/defaults";
import styles from "./share.module.css";

// One captured item. A failed capture carries no destination; a successful one
// carries the in-app `path` its "Open" action targets.
type CaptureResult =
  | {
      label: string;
      ok: true;
      status: string;
      path: string;
      mediaId?: string;
    }
  | {
      label: string;
      ok: false;
      reason: "Capture" | "Unauthenticated";
      feedback: FeedbackContent;
    };

export default function ShareCapture({
  text,
  isShell,
}: {
  text: string;
  isShell: boolean;
}) {
  const trimmed = text.trim();
  const urls = useMemo(() => extractUrls(trimmed), [trimmed]);
  const [results, setResults] = useState<CaptureResult[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [creatingDestination, setCreatingDestination] = useState(false);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Capture fires once per attempt. The guard survives React's mount-effect
  // double-invoke; the caller block id also makes transport retries converge on
  // the same daily-note block.
  const capturedAttempt = useRef<number | null>(null);
  const quickCaptureBlockId = useRef(createRandomId());
  const quickCaptureMutationId = useRef(createRandomId("share-note-mutation"));
  const urlIdempotencyKeys = useRef<Map<string, string>>(new Map());
  const [selectedDestinations, setSelectedDestinations] = useState<
    readonly LibraryDestinationSelection[]
  >([]);

  useEffect(() => {
    if (!trimmed || urls.length > 0 || capturedAttempt.current === attempt) {
      return;
    }
    capturedAttempt.current = attempt;
    setResults(null);

    void (async () => {
      try {
        await quickCaptureDailyNote({
          blockId: quickCaptureBlockId.current,
          clientMutationId: quickCaptureMutationId.current,
          bodyPmJson: {
            type: "paragraph",
            content: [{ type: "text", text: trimmed }],
          },
        });
        setResults([
          {
            label: trimmed,
            ok: true,
            status: "Added to today",
            path: "/notes",
          },
        ]);
      } catch {
        setResults([
          {
            label: trimmed,
            ok: false,
            reason: "Capture",
            feedback: { severity: "error", title: "Couldn’t save" },
          },
        ]);
      }
    })();
  }, [trimmed, urls.length, attempt]);

  const doneHref = isShell ? "nexus-share://done" : APP_AUTHENTICATED_HOME_HREF;
  const cancelHref = isShell
    ? "nexus-share://dismiss"
    : APP_AUTHENTICATED_HOME_HREF;

  async function saveUrls(targetUrls: string[]) {
    if (saving || creatingDestination) return;
    setSaving(true);
    try {
      const outcomes = await runBoundedTasks({
        items: targetUrls,
        concurrency: 2,
        run: saveUrl,
      });
      const settled: CaptureResult[] = [];
      const defects: unknown[] = [];
      outcomes.forEach((outcome, index) => {
        const label = targetUrls[index];
        if (label === undefined) {
          defects.push(
            new Error("Share outcome did not match its source URL."),
          );
          return;
        }
        switch (outcome.kind) {
          case "Fulfilled":
            settled.push(outcome.value);
            return;
          case "Rejected":
            if (isUnauthenticatedApiError(outcome.error)) {
              settled.push({
                label,
                ok: false,
                reason: "Unauthenticated",
                feedback: {
                  severity: "error",
                  title: "Sign in to save this",
                  message: "Open Nexus, sign in, then share again.",
                },
              });
              return;
            }
            if (isSourceUrlCaptureDefect(outcome.error)) {
              defects.push(outcome.error);
              return;
            }
            defects.push(outcome.error);
        }
      });
      setResults((current) => {
        if (!current) return settled;
        const replacements = new Map(
          settled.map((result) => [result.label, result]),
        );
        return current.map(
          (result) => replacements.get(result.label) ?? result,
        );
      });
      if (defects.length > 0) throw defects[0];
    } finally {
      setSaving(false);
    }
  }

  async function saveUrl(url: string): Promise<CaptureResult> {
    let idempotencyKey = urlIdempotencyKeys.current.get(url);
    if (!idempotencyKey) {
      idempotencyKey = createRandomId("share-url");
      urlIdempotencyKeys.current.set(url, idempotencyKey);
    }
    const result = await captureSourceUrl({
      url,
      libraryIds: selectedDestinations.map((destination) => destination.id),
      idempotencyKey,
    });
    return result.ok ? result : { ...result, reason: "Capture" };
  }

  function runSaveUrls(targetUrls: string[]): void {
    void saveUrls(targetUrls).catch((error) => setDefect({ error }));
  }

  if (defect) throw defect.error;

  if (!trimmed) {
    return (
      <>
        <h1 className={styles.heading}>Nothing to share</h1>
        <p className={styles.body}>
          The shared text was empty, so there was nothing to save.
        </p>
        <div className={styles.actions}>
          <a className={styles.actionPrimary} href={doneHref}>
            Done
          </a>
        </div>
      </>
    );
  }

  if (urls.length > 0 && results === null) {
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
        <LibraryDestinationPicker
          selected={selectedDestinations}
          onChange={setSelectedDestinations}
          presentation={{ kind: "Inline" }}
          label="Library destinations"
          interaction={
            creatingDestination
              ? { kind: "Creating" }
              : saving
                ? { kind: "Disabled" }
                : { kind: "Enabled" }
          }
          onCreateDestination={async (name) => {
            setCreatingDestination(true);
            try {
              return await createLibrary({ name });
            } finally {
              setCreatingDestination(false);
            }
          }}
        />
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.actionPrimary}
            disabled={saving || creatingDestination}
            onClick={() => runSaveUrls(urls)}
          >
            {saving ? "Saving…" : "Save"}
          </button>
          <a className={styles.action} href={cancelHref}>
            Cancel
          </a>
        </div>
      </>
    );
  }

  if (results === null || saving) {
    return (
      <>
        <h1 className={styles.heading}>Saving to Nexus…</h1>
        <p className={styles.body}>Capturing what you shared.</p>
      </>
    );
  }

  const anyFailed = results.some((result) => !result.ok);
  const retryableFailures = results.filter(
    (result) => !result.ok && result.reason === "Capture",
  );
  const failedUrls = retryableFailures.map((result) => result.label);
  const authRequired = results.some(
    (result) => !result.ok && result.reason === "Unauthenticated",
  );

  return (
    <>
      <h1 className={styles.heading}>
        {results.some((result) => result.ok)
          ? "Saved to Nexus"
          : authRequired
            ? "Sign in to save this"
            : "Couldn’t save"}
      </h1>
      <div className={styles.results}>
        {results.map((result, index) => (
          <div key={index} className={styles.resultItem}>
            <span className={styles.resultLabel} title={result.label}>
              {result.label}
            </span>
            {result.ok ? (
              <>
                <span className={styles.resultStatus}>{result.status}</span>
                <div className={styles.actions}>
                  <a
                    className={styles.action}
                    href={
                      isShell
                        ? `nexus-share://open?path=${encodeURIComponent(result.path)}`
                        : result.path
                    }
                  >
                    {result.path === "/notes" ? "Open" : "Open in Nexus"}
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
        {retryableFailures.length > 0 && (
          <button
            type="button"
            className={styles.actionPrimary}
            disabled={saving || creatingDestination}
            onClick={() => {
              if (urls.length > 0) {
                runSaveUrls(failedUrls);
                return;
              }
              setAttempt((value) => value + 1);
            }}
          >
            Retry
          </button>
        )}
        <a
          className={anyFailed ? styles.action : styles.actionPrimary}
          href={doneHref}
        >
          Done
        </a>
      </div>
    </>
  );
}
