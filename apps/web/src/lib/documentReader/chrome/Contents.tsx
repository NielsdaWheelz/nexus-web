"use client";

// The publisher's contents, the current section marked; and the notice that
// names a publication's recorded defects.
import type { ReactElement, ReactNode } from "react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import ActionMenu from "@/components/ui/ActionMenu";
import { workspaceTargetActivationIntent } from "@/lib/ui/targetActivation";
import { useReaderState, type Reader } from "../DocumentReader";
import { sourceTarget, type SourceIssue, type TocNode } from "../model";
import { ReaderLink } from "../navigation";
import type { ReaderDestination } from "../location";
import styles from "./chrome.module.css";

export function Contents({
  reader,
  actions,
}: {
  readonly reader: Reader;
  readonly actions?: (sectionId: string) => ReactNode;
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
      {nodes.map(({ id, label, at, sectionId, children }) => {
        const chapter = ready.doc.kind === "text" ? ready.doc.transcriptNavigation?.chapters.find((chapter) => chapter.id === id) ?? null : null;
        const target: ReaderDestination["target"] | null = !at ? null : chapter ? { kind: "time", ms: chapter.startMs }
          : { kind: "point", point: { kind: "text", ...at } };
        const portable = target && sourceTarget(ready.doc, target);
        const destination = portable && { source_identity: ready.doc.identity, target: portable };
        const href = destination ? reader.navigation?.href(destination) ?? null : null;
        return <li key={id}>
          <div className={styles.tocRow}>
          {target ? (
            <ReaderLink
              reader={reader}
              target={target}
              className={styles.tocLink}
              aria-current={
                sectionId !== null && sectionId === current
                  ? "location"
                  : undefined
              }
            >
              {label}
            </ReaderLink>
          ) : (
            <span>{label}{ready.doc.kind === "text" && ready.doc.format === "transcript" ? <span className="sr-only">; no transcript at this time</span> : null}</span>
          )}
          {destination !== null || chapter !== null ? <ActionMenu label={`more actions for ${label}`} source={{ kind: "Immediate", subjectKey: `reader-contents:${ready.doc.identity}:${id}`, title: label,
            content: { sections: [{ id: "Open", label: null, options: [{ kind: "link", id: "OpenInPane", label: "open in new pane",
              ...(href === null ? { href: null, disabled: true as const } : { href }),
              disabledReason: !at && chapter ? "no transcript at this time" : href === null ? "opening this location in a new pane is unavailable" : undefined,
              onActivate: (event) => {
                const activation = workspaceTargetActivationIntent(event);
                if (activation.kind === "Unowned") return "unhandled";
                event.preventDefault();
                if (activation.kind === "Consume" || !destination || !reader.navigation) return "consumed";
                return reader.navigation.activate(destination, "new_pane", () => {}) === "Accepted" ? "handled-new-pane" : "consumed";
              },
            }] }] },
          }} /> : null}
          {sectionId !== null ? actions?.(sectionId) : null}
          </div>
          {children.length > 0 ? list(children) : null}
        </li>;
      })}
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
