"use client";

// The publisher's contents, the current section marked; and the notice that
// names a publication's recorded defects.
import type { ReactElement, ReactNode } from "react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import { useReaderState, type Reader } from "../DocumentReader";
import type { SourceIssue, TocNode } from "../model";
import { ReaderLink } from "../navigation";
import type { ReaderDestination } from "../location";
import styles from "./chrome.module.css";

/** One native publisher list; fetching, attachment ownership and commands stay with its caller. */
export function ContentsList({ reader, nodes, current, target, disabled = false, actions, detail, labelNote, attachments, onNavigate }: {
  readonly reader: Reader;
  readonly onNavigate?: (destination: ReaderDestination) => void;
  readonly nodes: readonly TocNode[];
  readonly current: string | null;
  readonly target: (node: TocNode) => ReaderDestination["target"] | null;
  readonly disabled?: boolean;
  readonly actions?: (node: TocNode) => ReactNode;
  readonly detail?: (node: TocNode) => ReactNode;
  readonly labelNote?: ReactNode;
  readonly attachments?: (nodeId: string | null) => readonly { readonly id: string; readonly content: ReactNode }[];
}): ReactElement {
  const list = (items: readonly TocNode[], root: boolean): ReactElement => <ul className={styles.toc}>
    {root ? attachments?.(null).map(row => <li key={row.id}>{row.content}</li>) : null}
    {items.map(node => {
      const destination = target(node);
      return <li key={node.id} data-contents-node={node.id}>
        <div className={styles.tocRow}>
          <div className={styles.tocTitle}>
            {destination ? <ReaderLink reader={reader} target={destination} disabled={disabled} onDefault={onNavigate}
              className={styles.tocLink} data-contents-source="true"
              aria-current={!disabled && node.sectionId !== null && node.sectionId === current ? "location" : undefined}>{node.label}</ReaderLink>
              : <span className={styles.tocLabel}>{node.label}{labelNote}</span>}
            {detail?.(node)}
          </div>
          {actions?.(node)}
        </div>
        {attachments?.(node.id).map(row => <div key={row.id} className={styles.tocAttachment}>{row.content}</div>)}
        {node.children.length > 0 ? list(node.children, false) : null}
      </li>;
    })}
  </ul>;
  return list(nodes, true);
}

export function Contents({ reader, onNavigate }: { readonly reader: Reader; readonly onNavigate?: (destination: ReaderDestination) => void }): ReactElement | null {
  const ready = useReaderState(reader, state => state.document.status === "ready" && state.document.doc.kind === "text" ? state.document : null);
  const current = useReaderState(reader, state => state.document.status === "ready" && state.viewport
    ? state.document.structure.sectionAt(state.viewport.primary)?.id ?? null : null);
  if (!ready || ready.doc.kind !== "text" || ready.doc.toc.length === 0) return null;
  const doc = ready.doc;
  return <nav className={styles.contents} aria-label="Contents">
    <ContentsList reader={reader} nodes={doc.toc} current={current} onNavigate={onNavigate}
      labelNote={doc.format === "transcript" ? <span className="sr-only">; no transcript at this time</span> : null} target={node => {
      const chapter = doc.transcriptNavigation?.chapters.find(chapter => chapter.id === node.id) ?? null;
      return !node.at ? null : chapter ? { kind: "time", ms: chapter.startMs }
        : { kind: "point", point: { kind: "text", ...node.at } };
    }} />
  </nav>;
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
