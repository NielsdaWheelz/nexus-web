"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import LibraryDestinationPicker from "@/components/LibraryDestinationPicker";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import { createRandomId } from "@/lib/createRandomId";
import { extractUrls } from "@/lib/extractUrls";
import {
  captureSourceUrl,
  runBoundedSourceUrlCaptures,
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
  | { label: string; ok: false; feedback: FeedbackContent };

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
  const [pickerBusy, setPickerBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // Capture fires once per attempt. The guard survives React's mount-effect
  // double-invoke; the caller block id also makes transport retries converge on
  // the same daily-note block.
  const capturedAttempt = useRef<number | null>(null);
  const quickCaptureBlockId = useRef(createRandomId());
  const quickCaptureMutationId = useRef(createRandomId("share-note-mutation"));
  const urlIdempotencyKeys = useRef<Map<string, string>>(new Map());
  const [selectedLibraryIds, setSelectedLibraryIds] = useState<string[]>([]);

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
	          bodyPmJson: { type: "paragraph", content: [{ type: "text", text: trimmed }] },
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
            feedback: { severity: "error", title: "Couldn’t save" },
          },
        ]);
      }
    })();
  }, [trimmed, urls.length, attempt]);

  const doneHref = isShell ? "nexus-share://done" : APP_AUTHENTICATED_HOME_HREF;
  const cancelHref = isShell ? "nexus-share://dismiss" : APP_AUTHENTICATED_HOME_HREF;

  async function saveUrls(targetUrls: string[]) {
    if (saving || pickerBusy) return;
    setSaving(true);
    const settled = await runBoundedSourceUrlCaptures(targetUrls, saveUrl);
    setResults((current) => {
      if (!current) return settled;
      const replacements = new Map(settled.map((result) => [result.label, result]));
      return current.map((result) => replacements.get(result.label) ?? result);
    });
    setSaving(false);
  }

  async function saveUrl(url: string): Promise<CaptureResult> {
    let idempotencyKey = urlIdempotencyKeys.current.get(url);
    if (!idempotencyKey) {
      idempotencyKey = createRandomId("share-url");
      urlIdempotencyKeys.current.set(url, idempotencyKey);
    }
    return captureSourceUrl({
      url,
      libraryIds: selectedLibraryIds,
      idempotencyKey,
    });
  }

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
          selectedLibraryIds={selectedLibraryIds}
          onChange={setSelectedLibraryIds}
          disabled={saving}
          label="Library destinations"
          onBusyChange={setPickerBusy}
        />
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.actionPrimary}
            disabled={saving || pickerBusy}
            onClick={() => void saveUrls(urls)}
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
  const failedUrls = results.filter((result) => !result.ok).map((result) => result.label);

  return (
    <>
      <h1 className={styles.heading}>
        {results.some((result) => result.ok)
          ? "Saved to Nexus"
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
        {anyFailed && (
          <button
            type="button"
            className={styles.actionPrimary}
            disabled={saving || pickerBusy}
            onClick={() => {
              if (urls.length > 0) {
                void saveUrls(failedUrls);
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
