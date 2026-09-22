import type { ReactElement } from "react";
import type {
  ReaderDocumentMapMarkerKind,
  ReaderMapMarkerPresentation,
} from "@/lib/reader/documentMap";
import styles from "./ReaderDocumentMapDestination.module.css";

type ReaderDocumentMapDestinationProps =
  | { kind: "Current"; positionLabel: string }
  | {
      kind: "Marker";
      destination: ReaderMapMarkerPresentation;
      positionLabel: string;
    };

export default function ReaderDocumentMapDestination(
  props: ReaderDocumentMapDestinationProps,
): ReactElement {
  if (props.kind === "Current") {
    return (
      <span className={styles.content}>
        <strong className={styles.title}>current position</strong>
        <span className={styles.metadata}>{props.positionLabel}</span>
      </span>
    );
  }

  const { marker, content } = props.destination;
  switch (content.kind) {
    case "Highlight": {
      const firstNote = content.notes[0];
      const additionalNotes = content.notes.length - 1;
      return (
        <span className={styles.content}>
          <span className={styles.kind}>highlight</span>
          {content.quote.kind === "Present" ? (
            <span className={styles.excerpt}>{content.quote.value}</span>
          ) : (
            <span className={styles.metadata}>no text quote</span>
          )}
          {firstNote ? (
            <span className={styles.note}>
              <span className={styles.kind}>
                {content.notes.length === 1
                  ? "note"
                  : `note 1 of ${content.notes.length}`}
              </span>
              {firstNote.excerpt.kind === "Present" ? (
                <span className={styles.noteExcerpt}>{firstNote.excerpt.value}</span>
              ) : (
                <span className={styles.metadata}>no note preview</span>
              )}
            </span>
          ) : null}
          {additionalNotes > 0 ? (
            <span className={styles.metadata}>
              {additionalNotes} more {additionalNotes === 1 ? "note" : "notes"}
            </span>
          ) : null}
          <span className={styles.metadata}>{props.positionLabel}</span>
        </span>
      );
    }
    case "Named":
      return (
        <span className={styles.content}>
          <span className={styles.kind}>{readerDocumentMapMarkerTypeLabel(marker.kind)}</span>
          <strong className={styles.title}>{content.label}</strong>
          {content.excerpt.kind === "Present" &&
          content.excerpt.value !== content.label ? (
            <span className={styles.excerpt}>{content.excerpt.value}</span>
          ) : null}
          <span className={styles.metadata}>{props.positionLabel}</span>
        </span>
      );
  }
}

export function readerDocumentMapMarkerTypeLabel(
  kind: ReaderDocumentMapMarkerKind,
): string {
  switch (kind) {
    case "Contents":
      return "contents";
    case "Embed":
      return "embed";
    case "Highlight":
      return "highlight";
    case "SourceReference":
      return "source reference";
    case "GeneratedCitation":
      return "citation";
    case "Link":
      return "link";
    case "Synapse":
      return "synapse";
  }
}
