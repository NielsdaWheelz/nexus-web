"use client";

import { useRef, useState } from "react";
import LibraryDestinationDisclosure from "@/components/LibraryDestinationDisclosure";
import Button from "@/components/ui/Button";
import {
  couldNotSubscribeCount,
  type OpmlImportState,
} from "@/components/launcher/addContentSessionModel";
import type { LibraryDestinationSelection } from "@/lib/libraries/client";
import styles from "./OpmlImportPanel.module.css";

interface OpmlImportPanelProps {
  state: OpmlImportState;
  destinations: readonly LibraryDestinationSelection[];
  disabled: boolean;
  creatingDestination: boolean;
  onFileChange(file: File | null): void;
  onDestinationsChange(
    destinations: readonly LibraryDestinationSelection[],
  ): void;
  onCreateDestination(name: string): Promise<LibraryDestinationSelection>;
  onManagePodcasts(): void;
}

function selectedFile(state: OpmlImportState): File | null {
  switch (state.kind) {
    case "Ready":
    case "Importing":
    case "Failed":
      return state.file;
    case "Invalid":
      return state.input.kind === "File" ? state.input.file : null;
    case "Empty":
    case "Complete":
      return null;
  }
}

function feedbackFor(state: OpmlImportState) {
  return state.kind === "Invalid" || state.kind === "Failed"
    ? state.feedback
    : null;
}

export default function OpmlImportPanel({
  state,
  destinations,
  disabled,
  creatingDestination,
  onFileChange,
  onDestinationsChange,
  onCreateDestination,
  onManagePodcasts,
}: OpmlImportPanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [destinationsOpen, setDestinationsOpen] = useState(false);
  const file = selectedFile(state);
  const feedback = feedbackFor(state);
  const feedbackId = "add-opml-feedback";
  const resultComplete = state.kind === "Complete";

  return (
    <div className={styles.root}>
      <section
        className={styles.fileSection}
        aria-labelledby="add-opml-file-label"
      >
        <div className={styles.fieldHeading}>
          <span id="add-opml-file-label">OPML file</span>
          <span>
            {file?.name ??
              (state.kind === "Complete"
                ? state.file.name
                : "No file selected")}
          </span>
        </div>
        {!resultComplete ? (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept=".opml,.xml,text/xml,application/xml"
              className={styles.fileInput}
              aria-label="Choose OPML file"
              aria-describedby={feedback ? feedbackId : undefined}
              disabled={disabled}
              onChange={(event) => {
                const next = event.target.files?.[0] ?? null;
                onFileChange(next);
                if (next) event.target.value = "";
              }}
            />
            <Button
              variant="secondary"
              size="md"
              disabled={disabled}
              onClick={() => fileInputRef.current?.click()}
            >
              {file ? "Choose a different file" : "Choose file"}
            </Button>
            <p className={styles.helper}>
              OPML or XML, up to 1 MB and 200 RSS feeds.
            </p>
          </>
        ) : null}
        {feedback ? (
          <p
            id={feedbackId}
            className={styles.feedback}
            data-severity={feedback.severity}
          >
            {feedback.title}
            {feedback.message ? ` ${feedback.message}` : ""}
            {feedback.requestId ? ` Request ID: ${feedback.requestId}` : ""}
          </p>
        ) : null}
      </section>

      <LibraryDestinationDisclosure
        label="Libraries for new subscriptions"
        emptySummary="No libraries selected"
        open={destinationsOpen}
        onOpenChange={setDestinationsOpen}
        selected={destinations}
        onChange={onDestinationsChange}
        interaction={
          creatingDestination
            ? { kind: "Creating" }
            : disabled || resultComplete
              ? { kind: "Disabled" }
              : { kind: "Enabled" }
        }
        onCreateDestination={onCreateDestination}
      />

      {state.kind === "Complete" ? (
        <section
          className={styles.importSummary}
          aria-labelledby="opml-summary-title"
        >
          <h3 id="opml-summary-title" className={styles.importSummaryTitle}>
            Import summary
          </h3>
          <dl className={styles.importStats}>
            <div>
              <dt>Total</dt>
              <dd>{state.result.total}</dd>
            </div>
            <div>
              <dt>Imported</dt>
              <dd>{state.result.imported}</dd>
            </div>
            <div>
              <dt>Already subscribed</dt>
              <dd>{state.result.skipped_already_subscribed}</dd>
            </div>
            <div>
              <dt>Invalid</dt>
              <dd>{state.result.skipped_invalid}</dd>
            </div>
            <div>
              <dt>Could not subscribe</dt>
              <dd>{couldNotSubscribeCount(state.result)}</dd>
            </div>
          </dl>
          {state.result.errors.length > 0 ? (
            <div className={styles.issues}>
              <h4>Issues</h4>
              <ul>
                {state.result.errors.map((issue, index) => (
                  <li key={`${issue.feed_url ?? "unknown"}-${index}`}>
                    {issue.feed_url ? `${issue.feed_url}: ` : ""}
                    {issue.error}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <Button variant="secondary" size="md" onClick={onManagePodcasts}>
            Manage podcasts
          </Button>
        </section>
      ) : null}
    </div>
  );
}
