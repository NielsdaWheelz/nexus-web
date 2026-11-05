"use client";

import { Fragment, useEffect, useId, useRef, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";
import * as Icon from "@/lib/ui/icons";
import Button from "@/components/ui/Button";
import Tooltip from "@/components/ui/Tooltip";
import type { HighlightColor } from "@/lib/documentReader/model";
import { useMobileViewport } from "@/lib/mobileShell/viewport";
import { cx } from "@/lib/ui/cx";
import { useOverlay, useOverlayContainer } from "@/lib/ui/overlay";
import { useAnchoredPosition } from "@/lib/ui/useAnchoredPosition";
import styles from "./media.module.css";

const COLOURS: readonly HighlightColor[] = ["yellow", "green", "blue", "pink", "purple"];

export function Colours({ selected, onSelect, disabledReason = null, persisted = true, size }: {
  readonly selected: HighlightColor | null;
  readonly onSelect: (color: HighlightColor) => void;
  readonly disabledReason?: string | null;
  readonly persisted?: boolean;
  readonly size?: "comfortable";
}) {
  const id = useId();
  return <div className={styles.colours} data-size={size} role="group" aria-label="highlight colours">
    {COLOURS.map((color) => {
      const reason = disabledReason;
      const label = `${color} highlight`;
      const reasonId = `${id}-${color}`;
      return <Fragment key={color}><Tooltip text={reason ? `${label}. ${reason}` : label} renderTrigger={(help) => (
        <button {...help} type="button" className={styles.colour} aria-label={label}
          aria-describedby={cx(help["aria-describedby"], reason ? reasonId : undefined) || undefined}
          aria-pressed={selected === color} aria-disabled={reason !== null || undefined}
          onClick={(event) => { if (reason) event.preventDefault(); else if (!persisted || selected !== color) onSelect(color); }}>
          <span className={styles.colourFill} style={{ background: `var(--highlight-${color})` }} aria-hidden="true">
            {selected === color ? <Icon.Check size={16} /> : null}
          </span>
        </button>
      )} />{reason ? <span id={reasonId} className="sr-only">{reason}</span> : null}</Fragment>;
    })}
  </div>;
}

/** The direct command shared by desktop split controls and the mobile toolbar. */
function HighlightButton({ selected, persisted, disabledReason, busy, onClick }: {
  readonly selected: HighlightColor;
  readonly persisted: boolean;
  readonly disabledReason: string | null;
  readonly busy: boolean;
  readonly onClick: () => void;
}) {
  const id = useId();
  const label = persisted ? `highlighted ${selected}` : `highlight ${selected}`;
  const reason = disabledReason;
  return <>
    <Button iconOnly className={styles.selectionIcon} aria-busy={busy || undefined}
      aria-label={label} aria-pressed={persisted} aria-disabled={reason !== null || undefined}
      aria-describedby={reason ? id : undefined}
      tooltip={{ text: reason ? `${label}. ${reason}` : label }}
      onClick={event => { if (reason) event.preventDefault(); else if (!persisted) onClick(); }}
      icon={<><Icon.Highlight /><span className={styles.highlightColour} style={{ background: `var(--highlight-${selected})` }} /></>} />
    {reason ? <span id={id} className="sr-only">{reason}</span> : null}
  </>;
}

/** A direct highlight command beside a transient choice; neither owns the note editor. */
export default function HighlightColourPicker({ active, selected, persisted, disabledReason, busy, onSelect, primaryAction, size }: {
  readonly active: boolean;
  readonly selected: HighlightColor;
  readonly persisted: boolean;
  readonly disabledReason: string | null;
  readonly busy: boolean;
  readonly onSelect: (color: HighlightColor) => void;
  /** The fresh mobile composer saves the note and colour with one command. */
  readonly primaryAction?: ReactElement;
  readonly size?: "comfortable";
}) {
  const [open, setOpen] = useState(false);
  const shown = active && open;
  const trigger = useRef<HTMLButtonElement | null>(null);
  const id = useId();
  const container = useOverlayContainer();
  const mobileViewport = useMobileViewport();
  const position = useAnchoredPosition<HTMLDivElement>(trigger, {
    enabled: shown,
    placement: "below",
    align: "start",
    flip: true,
    subscribeContentClearance: mobileViewport.subscribeContentBottomClearance,
  });
  useOverlay(shown, {
    kind: "transient",
    onDismiss: () => setOpen(false),
    inside: () => [position.ref.current, trigger.current],
    returnFocus: true,
    returnFocusTo: () => trigger.current ? { element: trigger.current, preventScroll: true } : null,
    tabContinuation: () => position.ref.current,
  });
  const focused = useRef(false);
  useEffect(() => { if (!active) setOpen(false); }, [active]);
  useEffect(() => {
    if (!shown) { focused.current = false; return; }
    if (!position.placed || focused.current) return;
    const frame = requestAnimationFrame(() => {
      const target = position.ref.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]');
      if (target) { target.focus({ preventScroll: true }); focused.current = true; }
    });
    return () => cancelAnimationFrame(frame);
  }, [shown, position.placed, position.ref]);
  useEffect(() => {
    if (!shown) return;
    const composer = trigger.current?.closest("[data-selection-composer]");
    const close = () => setOpen(false);
    composer?.addEventListener("scroll", close, { passive: true });
    return () => composer?.removeEventListener("scroll", close);
  }, [shown]);

  return <div className={styles.highlightControl}>
    {primaryAction ?? <HighlightButton selected={selected} persisted={persisted} disabledReason={disabledReason} busy={busy} onClick={() => onSelect(selected)} />}
    <Button ref={trigger} iconOnly className={styles.selectionIcon}
        aria-label="choose highlight colour" aria-expanded={shown} aria-controls={shown ? id : undefined}
        aria-disabled={disabledReason !== null || undefined}
        aria-describedby={disabledReason ? `${id}-disclosure-reason` : undefined}
        tooltip={{ text: disabledReason ? `choose highlight colour. ${disabledReason}` : "choose highlight colour" }}
        onClick={() => { if (disabledReason === null) setOpen(!open); }}
        icon={<><Icon.Choose />{primaryAction ? <span className={styles.highlightColour} style={{ background: `var(--highlight-${selected})` }} /> : null}</>}
    />
    {disabledReason ? <span id={`${id}-disclosure-reason`} className="sr-only">{disabledReason}</span> : null}
    {shown && container ? createPortal(
      <div id={id} ref={position.ref} className={styles.colourPopover} style={{ ...position.style, maxBlockSize: "var(--anchored-max-height)" }}>
        <Colours selected={selected} persisted={persisted} disabledReason={disabledReason} size={size}
          onSelect={(color) => { setOpen(false); onSelect(color); }} />
      </div>,
      container,
    ) : null}
  </div>;
}
