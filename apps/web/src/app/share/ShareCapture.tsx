"use client";

import { useEffect, useRef, useState } from "react";
import { extractUrls } from "@/lib/extractUrls";
import { addMediaFromUrl } from "@/lib/media/ingestionClient";
import { quickCaptureDailyNote } from "@/lib/notes/api";
import styles from "./share.module.css";

// One captured item. A failed capture carries no destination; a successful one
// carries the in-app `path` its "Open" action targets.
type CaptureResult =
  | { label: string; ok: true; status: string; path: string }
  | { label: string; ok: false };

export default function ShareCapture({
  text,
  isShell,
}: {
  text: string;
  isShell: boolean;
}) {
  const trimmed = text.trim();
  // `null` while capturing; the settled list once every item is done.
  const [results, setResults] = useState<CaptureResult[] | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Capture fires once per attempt. The guard survives React's mount-effect
  // double-invoke, which would otherwise post a second daily-note bullet
  // (quickCaptureDailyNote is not idempotent, unlike from-url).
  const capturedAttempt = useRef<number | null>(null);

  useEffect(() => {
    if (!trimmed || capturedAttempt.current === attempt) {
      return;
    }
    capturedAttempt.current = attempt;
    setResults(null);

    void (async () => {
      const urls = extractUrls(trimmed);
      if (urls.length > 0) {
        setResults(
          await Promise.all(
            urls.map(async (url): Promise<CaptureResult> => {
              try {
                const { mediaId, duplicate } = await addMediaFromUrl({ url });
                return {
                  label: url,
                  ok: true,
                  status: duplicate ? "Already in your library" : "Saved",
                  path: `/media/${mediaId}`,
                };
              } catch {
                return { label: url, ok: false };
              }
            }),
          ),
        );
        return;
      }
      try {
        await quickCaptureDailyNote({ bodyMarkdown: trimmed });
        setResults([
          {
            label: trimmed,
            ok: true,
            status: "Added to today",
            path: "/daily",
          },
        ]);
      } catch {
        setResults([{ label: trimmed, ok: false }]);
      }
    })();
  }, [trimmed, attempt]);

  const doneHref = isShell ? "nexus-share://dismiss" : "/";

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

  if (results === null) {
    return (
      <>
        <h1 className={styles.heading}>Saving to Nexus…</h1>
        <p className={styles.body}>Capturing what you shared.</p>
      </>
    );
  }

  const anyFailed = results.some((result) => !result.ok);

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
                    {result.path === "/daily" ? "Open" : "Open in Nexus"}
                  </a>
                </div>
              </>
            ) : (
              <span className={styles.error}>Couldn’t save</span>
            )}
          </div>
        ))}
      </div>
      <div className={styles.actions}>
        {anyFailed && (
          <button
            type="button"
            className={styles.actionPrimary}
            onClick={() => setAttempt((value) => value + 1)}
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
