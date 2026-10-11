"use client";

import type { MouseEvent } from "react";
import { useHoverPreview } from "@/components/ui/HoverPreview";
import { truncateText } from "@/lib/display/format";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import type {
  ReaderCitationPreview,
  ReaderSourceTarget,
} from "@/lib/resourceGraph/citations";
import type { ResourceActivation } from "@/lib/resources/activation";
import { cx } from "@/lib/ui/cx";
import styles from "./ReaderCitation.module.css";

/**
 * A citation mark `[n]`. It opens its source in the pane (an anchor, so
 * shift-click forks), or, when it only has a located target, runs `onActivate`;
 * with neither it is unavailable and only previews. Hover or keyboard focus
 * previews the source.
 */
export default function ReaderCitation({
  index,
  preview,
  activation,
  target,
  onActivate,
}: {
  index: number;
  preview: ReaderCitationPreview;
  activation: ResourceActivation;
  target: ReaderSourceTarget | null;
  onActivate: (
    activation: ResourceActivation,
    target: ReaderSourceTarget | null,
    event?: MouseEvent,
  ) => void;
}) {
  const runtime = usePaneRuntime();
  const href = activation.href;
  // The activation's address wins over the target's own.
  const located =
    target && href && target.href !== href ? { ...target, href } : target;
  const linkHref = located?.href ?? href ?? null;
  const opens = located !== null || Boolean(href);
  const hover = useHoverPreview(
    Boolean(
      preview.title ||
      preview.summary ||
      preview.excerpt ||
      preview.meta?.length ||
      opens,
    ),
  );
  const card = hover.render(
    <>
      {preview.title ? (
        <div className={styles.title}>{truncateText(preview.title, 96)}</div>
      ) : null}
      {preview.summary ? (
        <div className={styles.summary}>
          {truncateText(preview.summary, 140)}
        </div>
      ) : null}
      {preview.excerpt ? (
        <div className={styles.excerpt}>{preview.excerpt}</div>
      ) : null}
      {preview.meta?.map((entry, i) => (
        <div key={i} className={styles.meta}>
          {entry}
        </div>
      ))}
      {opens ? (
        <button
          type="button"
          className={styles.action}
          onClick={(event) => {
            event.stopPropagation();
            onActivate(activation, located, event);
            hover.close();
          }}
        >
          {located ? "Open in context" : "Open source"}
        </button>
      ) : null}
    </>,
  );
  const label = opens ? `Open citation ${index}` : `Citation ${index}`;
  const external = !located && /^https?:\/\//.test(href ?? "");

  return (
    <>
      {linkHref ? (
        <a
          className={styles.citation}
          href={linkHref}
          target={external ? "_blank" : undefined}
          rel={external ? "noopener noreferrer" : undefined}
          aria-label={label}
          data-workspace-rich-target="true"
          data-pane-find-exclude="true"
          {...hover.trigger}
          onClick={(event) => {
            onActivate(activation, located, event);
            if (event.defaultPrevented) return;
            activateTargetLink({
              event,
              runtime,
              href: linkHref,
              labelHint: located?.label,
            });
          }}
        >
          {index}
        </a>
      ) : (
        <button
          type="button"
          className={cx(styles.citation, !located && styles.unavailable)}
          aria-label={label}
          data-pane-find-exclude="true"
          {...hover.trigger}
          onClick={(event) =>
            located
              ? onActivate(activation, located, event)
              : hover.show(event.currentTarget)
          }
        >
          {index}
        </button>
      )}
      {card}
    </>
  );
}
