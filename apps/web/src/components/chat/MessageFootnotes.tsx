/**
 * MessageFootnotes — scholarly footnote list for assistant citations.
 *
 * Receives the memoized ReaderCitationData[] array from AssistantMessage and
 * renders a numbered list below the prose. Each entry is an active link
 * (or button when only an activationTarget exists) mirroring the ReaderCitation
 * conditional already used for in-prose markers.
 */

"use client";

import type { ReaderCitationData } from "@/lib/conversations/readerCitation";
import type { ReaderSourceTarget } from "@/lib/conversations/readerTarget";
import { hrefForResourceActivation, type ResourceActivation } from "@/lib/resources/activation";
import styles from "./MessageFootnotes.module.css";

function FootnoteLink({
  citation,
  onActivate,
}: {
  citation: ReaderCitationData;
  onActivate: (
    activation: ResourceActivation,
    target: ReaderSourceTarget | null,
    event?: React.MouseEvent,
  ) => void;
}) {
  const href = hrefForResourceActivation(citation.activation);
  const { activation, target, preview, index } = citation;

  // Resolve the effective target — mirror ReaderCitation's activationTarget logic.
  const activationTarget =
    target && href && target.href !== href ? { ...target, href } : target;

  const title = preview.title || `Source ${index}`;
  const sectionLabel = preview.meta?.[0];

  const label = (
    <>
      {index}.{" "}
      <span className={styles.footnoteTitle}>{title}</span>
      {sectionLabel ? (
        <span className={styles.footnoteMeta}> — {sectionLabel}</span>
      ) : null}
    </>
  );

  if (href && !target) {
    const isExternal = href.startsWith("http://") || href.startsWith("https://");
    return (
      <a
        className={styles.footnoteLink}
        href={href}
        target={isExternal ? "_blank" : undefined}
        rel={isExternal ? "noopener noreferrer" : undefined}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.altKey || event.button !== 0) return;
          event.preventDefault();
          onActivate(activation, null, event);
        }}
      >
        {label}
      </a>
    );
  }

  if (activationTarget) {
    const targetHref = activationTarget.href ?? href ?? null;
    if (targetHref) {
      return (
        <a
          className={styles.footnoteLink}
          href={targetHref}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.altKey || event.button !== 0) return;
            event.preventDefault();
            onActivate(activation, activationTarget, event);
          }}
        >
          {label}
        </a>
      );
    }
    return (
      <button
        type="button"
        className={styles.footnoteLink}
        onClick={(event) => {
          onActivate(activation, activationTarget, event);
        }}
      >
        {label}
      </button>
    );
  }

  // Unavailable citation — plain text, no interaction.
  return <span className={styles.footnoteLink}>{label}</span>;
}

export default function MessageFootnotes({
  citations,
  onCitationActivate,
}: {
  citations: ReaderCitationData[];
  onCitationActivate?: (
    activation: ResourceActivation,
    target: ReaderSourceTarget | null,
    event?: React.MouseEvent,
  ) => void;
}) {
  if (citations.length === 0) return null;

  const handleActivate = onCitationActivate ?? (() => undefined);

  return (
    <div className={styles.footnotes}>
      <ol className={styles.footnoteList} aria-label="Sources">
        {citations.map((c) => (
          <li key={c.index} className={styles.footnoteEntry}>
            <FootnoteLink citation={c} onActivate={handleActivate} />
          </li>
        ))}
      </ol>
    </div>
  );
}
