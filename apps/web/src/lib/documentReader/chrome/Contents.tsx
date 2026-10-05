"use client";

// The publisher's contents, the current section marked; and the notice that
// names a publication's recorded defects.
import type { ReactElement } from "react";
import { useReaderState, type Reader } from "../DocumentReader";
import type { SourceIssue, TextPoint, TocNode } from "../model";
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
  const go = (at: TextPoint) =>
    void reader.inspect({ kind: "point", point: { kind: "text", ...at } });
  const list = (nodes: readonly TocNode[]) => (
    <ul className={styles.toc}>
      {nodes.map(({ id, label, at, sectionId, children }) => (
        <li key={id}>
          {at ? (
            <button
              type="button"
              aria-current={
                sectionId !== null && sectionId === current
                  ? "location"
                  : undefined
              }
              onClick={() => go(at)}
            >
              {label}
            </button>
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
  const links = issues.length - images;
  return (
    <aside className={styles.issues} aria-label="Source issues">
      <strong>
        {readable ? "Readable with issues" : "Recorded source issues"}
      </strong>
      {images > 0 ? (
        <p>
          {images === 1
            ? "One image reference is unavailable."
            : `${images} image references are unavailable.`}
          {readable ? " You can read the available text." : null}
        </p>
      ) : null}
      {links > 0 ? (
        <p>
          {links === 1
            ? "One contents link is unavailable."
            : `${links} contents links are unavailable.`}
          {readable ? " You can still read the book in order." : null}
        </p>
      ) : null}
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
              ) : (
                <>
                  Contents link {issue.node_id}: <code>{issue.href}</code>
                </>
              )}
            </li>
          ))}
        </ol>
      </details>
    </aside>
  );
}
