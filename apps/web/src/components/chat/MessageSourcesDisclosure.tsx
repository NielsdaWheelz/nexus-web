/**
 * MessageSourcesDisclosure — compact source list for assistant citations.
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
import styles from "./MessageSourcesDisclosure.module.css";

function SourceLink({
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
      <span className={styles.sourceTitle}>{title}</span>
      {sectionLabel ? (
        <span className={styles.sourceMeta}> — {sectionLabel}</span>
      ) : null}
    </>
  );

  if (href && !target) {
    const isExternal = href.startsWith("http://") || href.startsWith("https://");
    return (
      <a
        className={styles.sourceLink}
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
          className={styles.sourceLink}
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
        className={styles.sourceLink}
        onClick={(event) => {
          onActivate(activation, activationTarget, event);
        }}
      >
        {label}
      </button>
    );
  }

  // Unavailable citation — plain text, no interaction.
  return <span className={styles.sourceLink}>{label}</span>;
}

export default function MessageSourcesDisclosure({
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
    <details className={styles.sources}>
      <summary>Sources ({citations.length})</summary>
      <ol className={styles.sourceList} aria-label="Sources">
        {citations.map((citation) => (
          <li key={citation.index} className={styles.sourceEntry}>
            <SourceLink citation={citation} onActivate={handleActivate} />
          </li>
        ))}
      </ol>
    </details>
  );
}
