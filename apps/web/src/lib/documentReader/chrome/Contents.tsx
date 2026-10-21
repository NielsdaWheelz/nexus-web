"use client";

// The publisher's contents, the current section marked; and the notice that
// names a publication's recorded defects.
import type { ReactElement } from "react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import { useReaderState, type Reader } from "../DocumentReader";
import type { SourceIssue, TocNode } from "../model";
import { ReaderLink } from "../navigation";
import styles from "./chrome.module.css";

export function Contents({
  reader,
}: {
  readonly reader: Reader;
}): ReactElement | null {
  const ready = useReaderState(reader, (state) =>
    state.document.status === "ready" && state.document.doc.kind === "text"
      ? state.document
      : null,
  );
  const current = useReaderState(reader, (state) =>
    state.document.status === "ready" && state.viewport
      ? (state.document.structure.sectionAt(state.viewport.primary)?.id ?? null)
      : null,
  );
  if (!ready || ready.doc.kind !== "text" || ready.doc.toc.length === 0)
    return null;
  const list = (nodes: readonly TocNode[]) => (
    <ul className={styles.toc}>
      {nodes.map(({ id, label, at, sectionId, children }) => (
        <li key={id}>
          {at ? (
            <ReaderLink
              reader={reader}
              target={{ kind: "point", point: { kind: "text", ...at } }}
              aria-current={
                sectionId !== null && sectionId === current
                  ? "location"
                  : undefined
              }
            >
              {label}
            </ReaderLink>
          ) : (
            <span>{label}</span>
          )}
          {children.length > 0 ? list(children) : null}
        </li>
      ))}
    </ul>
  );
  return (
    <nav className={styles.contents} aria-label="Contents">
      {list(ready.doc.toc)}
    </nav>
  );
}

export function SourceIssuesNotice({
  issues,
  readable,
}: {
  readonly issues: readonly SourceIssue[];
  readonly readable: boolean;
}): ReactElement | null {
  if (issues.length === 0) return null;
  const images = issues.filter((issue) => issue.kind === "MissingImage").length;
  const links = issues.filter((issue) => issue.kind === "UnresolvedNavigationTarget").length;
  const unavailable = [
    images > 0 ? `${images} ${images === 1 ? "image" : "images"}` : null,
    links > 0 ? `${links} contents ${links === 1 ? "link" : "links"}` : null,
  ].filter(Boolean).join(" and ");
  return (
    <aside className={styles.issues} aria-label="Source issues">
      <FeedbackNotice
        content={{
          tone: "Warning",
          // TooManyNotes alone: a web article's notes over budget stay in its text
          title: unavailable ? `${unavailable} unavailable in this copy` : "notes kept in the text",
          message: !unavailable
            ? "this article has too many notes to show them separately."
            : readable
              ? "the available text can still be read."
              : undefined,
        }}
        announcement="None"
      />
      <details>
        <summary>Issue details ({issues.length})</summary>
        <ol>
          {issues.map((issue, index) => (
            <li key={index}>
              {issue.kind === "MissingImage" ? (
                <>
                  Image {issue.marker_ordinal + 1}:{" "}
                  <code>{issue.resource_path}</code>
                </>
              ) : issue.kind === "UnresolvedNavigationTarget" ? (
                <>
                  Contents link {issue.node_id}: <code>{issue.href}</code>
                </>
              ) : (
                <>Notes: too many to extract; they stay in the text</>
              )}
            </li>
          ))}
        </ol>
      </details>
    </aside>
  );
}
