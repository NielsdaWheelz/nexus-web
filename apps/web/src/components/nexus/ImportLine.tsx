"use client";

/**
 * One intake line, two rows on every shell: line one is the pointer, mono, until the work is
 * readable, then its title in the reader's face; line two is what is true now. It renders a
 * `lineView` and runs nothing: its surface runs the verb its button names, and supplies a
 * settled line's menu as `children`, since only the workspace has resource actions.
 */
import { useState, type ReactNode } from "react";
import * as Icon from "@/lib/ui/icons";
import Button from "@/components/ui/Button";
import ButtonLink from "@/components/ui/ButtonLink";
import type { IntakeLine } from "@/lib/imports/intake";
import { pointer, type LineVerb, type LineView } from "@/lib/imports/lineView";
import styles from "./ImportPage.module.css";

/** The verbs a line's button carries; the row's own enter carries Arm and Open. */
export type ButtonVerb = Exclude<LineVerb, { kind: "Arm" | "Open" | "OpenOriginal" }>;

/** A line's spoken name: line one, then line two with its ` · ` read as a pause. */
export const lineName = (view: LineView) => `${view.one.text}, ${view.two.replaceAll(" · ", ", ")}`;

export default function ImportLine({ line, view, tabbable, onVerb, onDismiss, children }: {
  readonly line: IntakeLine;
  readonly view: LineView;
  /** Whether its controls are in the tab order: the selected line's, or every line's on a phone. */
  readonly tabbable: boolean;
  readonly onVerb: (verb: ButtonVerb) => void;
  readonly onDismiss: () => void;
  /** The settled line's menu. */
  readonly children?: ReactNode;
}) {
  // the ink crossfades once, when the work becomes readable here; a line already titled
  // when it mounts shows its title at once
  const [titledAtMount] = useState(view.one.kind === "Title");
  const titled = view.one.kind === "Title";
  const verb = view.verb;
  const tabIndex = tabbable ? 0 : -1;
  const percent = view.rule === null ? 0 : Math.floor(view.rule * 100);
  return <>
    <div className={styles.lineText}>
      <div className={styles.one} data-ink={titled || undefined} data-inking={titled && !titledAtMount || undefined}>
        <span className={styles.pointer} title={line.source.kind === "Link" ? line.source.url : line.source.name} aria-hidden={titled || undefined}>
          {pointer(line)}
        </span>
        {titled ? <span className={styles.title}>{view.one.text}</span> : null}
      </div>
      <div className={styles.two} data-tone={view.tone}>{view.two}</div>
    </div>
    <div className={styles.tail}>
      {verb === null || verb.kind === "Arm" || verb.kind === "Open" ? null
        : verb.kind === "OpenOriginal"
          ? <ButtonLink href={verb.href} target="_blank" rel="noopener noreferrer" tabIndex={tabIndex}
            aria-label={`${verb.label} ${view.one.text}`} className={styles.verb}>{verb.label}</ButtonLink>
          : <Button tabIndex={tabIndex} aria-label={`${verb.label} ${view.one.text}`} className={styles.verb}
            onClick={() => onVerb(verb)}>{verb.label}</Button>}
      {children}
      {view.dismiss === null ? null
        : <Button iconOnly icon={<Icon.Dismiss size={16} aria-hidden="true" />} tabIndex={tabIndex} className={styles.dismiss}
          aria-label={`${view.dismiss.toLowerCase()} ${view.one.text}`} onClick={onDismiss} />}
    </div>
    {view.rule === null ? null
      : <div role="progressbar" aria-label={`uploading ${view.one.text}`} aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={percent} aria-valuetext={`${percent}%`} className={styles.rule} style={{ inlineSize: `calc((100% - var(--text-edge)) * ${view.rule})` }} />}
  </>;
}
