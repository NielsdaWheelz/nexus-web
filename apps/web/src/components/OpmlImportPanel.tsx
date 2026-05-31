"use client";

import { useCallback, useRef, useState } from "react";
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import { apiFetch } from "@/lib/api/client";
import Button from "@/components/ui/Button";
import styles from "./AddContentTray.module.css";

type PodcastOpmlImportResult = {
  total: number;
  imported: number;
  skipped_already_subscribed: number;
  skipped_invalid: number;
  errors: Array<{
    feed_url: string | null;
    error: string;
  }>;
};

export default function OpmlImportPanel({
  defaultLibraryIds,
}: {
  defaultLibraryIds: string[];
}) {
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<FeedbackContent | null>(null);
  const [importResult, setImportResult] = useState<PodcastOpmlImportResult | null>(null);
  const opmlInputRef = useRef<HTMLInputElement>(null);

  const handleImportOpml = useCallback(async () => {
    if (!importFile) {
      setImportError({
        severity: "error",
        title: "Select an OPML/XML file to import.",
      });
      return;
    }
    setImportBusy(true);
    setImportError(null);
    setImportResult(null);
    try {
      const opmlText = await importFile.text();
      const responseBody = await apiFetch<{ data?: PodcastOpmlImportResult }>(
        "/api/podcasts/import/opml",
        {
          method: "POST",
          body: JSON.stringify({
            opml: opmlText,
            default_library_ids: defaultLibraryIds,
            per_feed_library_ids: {},
          }),
        }
      );
      if (!responseBody?.data) {
        throw new Error("Import response missing summary payload");
      }
      setImportResult(responseBody.data);
    } catch (error) {
      setImportError(toFeedback(error, { fallback: "Failed to import OPML file" }));
    } finally {
      setImportBusy(false);
    }
  }, [defaultLibraryIds, importFile]);

  return (
    <>
      <div className={styles.opmlFieldset}>
        <label className={styles.libraryLabel} htmlFor="opml-file-input">
          OPML file
        </label>
        <div className={styles.opmlFileRow}>
          <input
            id="opml-file-input"
            ref={opmlInputRef}
            type="file"
            accept=".opml,.xml,text/xml,application/xml,application/octet-stream"
            className={styles.fileInput}
            aria-label="Import OPML file"
            onChange={(event) => {
              setImportFile(event.target.files?.[0] ?? null);
              setImportError(null);
              setImportResult(null);
            }}
          />
          <Button
            variant="secondary"
            size="md"
            onClick={() => opmlInputRef.current?.click()}
          >
            Choose file
          </Button>
          <span className={styles.opmlInputLabel}>
            {importFile?.name ?? "No file selected"}
          </span>
        </div>
        <small className={styles.opmlHelper}>
          Import podcast subscriptions from another app as one explicit add action.
        </small>
      </div>

      <div className={styles.importActions}>
        <Button
          variant="primary"
          size="md"
          onClick={handleImportOpml}
          disabled={importBusy}
        >
          {importBusy ? "Importing..." : "Import OPML"}
        </Button>
      </div>

      {importError ? <FeedbackNotice feedback={importError} /> : null}

      {importResult ? (
        <div className={styles.importSummary}>
          <h3 className={styles.importSummaryTitle}>Import summary</h3>
          <div className={styles.importStats}>
            <span>Total: {importResult.total}</span>
            <span>Imported: {importResult.imported}</span>
            <span>Already followed: {importResult.skipped_already_subscribed}</span>
            <span>Invalid: {importResult.skipped_invalid}</span>
          </div>
          {importResult.errors.length > 0 ? (
            <div className={styles.importErrors}>
              {importResult.errors.map((error, index) => (
                <div key={`${error.feed_url ?? "missing"}-${index}`}>
                  {error.feed_url ? `${error.feed_url}: ` : ""}
                  {error.error}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
