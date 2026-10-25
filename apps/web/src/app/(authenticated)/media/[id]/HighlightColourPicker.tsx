"use client";

import { Fragment, useEffect, useId, useRef, useState, type FocusEventHandler, type KeyboardEventHandler, type MouseEventHandler, type PointerEventHandler } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Highlighter } from "lucide-react";
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
      const reason = disabledReason ?? (persisted && selected === color ? "this colour is already applied." : null);
      const label = `${color} highlight`;
      const reasonId = `${id}-${color}`;
      return <Fragment key={color}><Tooltip text={reason ? `${label}. ${reason}` : label} renderTrigger={(help) => (
        <button {...help} type="button" className={styles.colour} aria-label={label}
          aria-describedby={cx(help["aria-describedby"], reason ? reasonId : undefined) || undefined}
          aria-pressed={selected === color} aria-disabled={reason !== null || undefined}
          onClick={(event) => { if (reason) event.preventDefault(); else onSelect(color); }}>
          <span className={styles.colourFill} style={{ background: `var(--highlight-${color})` }} aria-hidden="true">
            {selected === color ? <Check size={16} /> : null}
          </span>
        </button>
      )} />{reason ? <span id={reasonId} className="sr-only">{reason}</span> : null}</Fragment>;
    })}
  </div>;
}

/** The direct command shared by desktop split controls and the mobile toolbar. */
export function HighlightButton({ selected, persisted, disabledReason, busy, onClick, onPointerDown, onKeyDown, onFocus }: {
  readonly selected: HighlightColor;
  readonly persisted: boolean;
  readonly disabledReason: string | null;
  readonly busy: boolean;
  readonly onClick: MouseEventHandler<HTMLButtonElement>;
  readonly onPointerDown?: PointerEventHandler<HTMLButtonElement>;
  readonly onKeyDown?: KeyboardEventHandler<HTMLButtonElement>;
  readonly onFocus?: FocusEventHandler<HTMLButtonElement>;
}) {
  const id = useId();
  const label = persisted ? `highlighted ${selected}` : "highlight yellow";
  const reason = disabledReason ?? (persisted ? "this colour is already applied. choose another colour to change it." : null);
  return <>
    <Button iconOnly className={styles.selectionIcon} aria-busy={busy || undefined}
      aria-label={label} aria-disabled={reason !== null || undefined}
      aria-describedby={reason ? id : undefined}
      tooltip={{ text: reason ? `${label}. ${reason}` : label }}
      onClick={onClick} onPointerDown={onPointerDown} onKeyDown={onKeyDown} onFocus={onFocus}
      icon={<><Highlighter size={16} /><span className={styles.highlightColour} style={{ background: `var(--highlight-${selected})` }} /></>} />
    {reason ? <span id={id} className="sr-only">{reason}</span> : null}
  </>;
}

/** A direct highlight command beside a transient choice; neither owns the note editor. */
export default function HighlightColourPicker({ selected, persisted, disabledReason, busy, onSelect }: {
  readonly selected: HighlightColor;
  readonly persisted: boolean;
  readonly disabledReason: string | null;
  readonly busy: boolean;
  readonly onSelect: (color: HighlightColor) => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const id = useId();
  const container = useOverlayContainer();
  const mobileViewport = useMobileViewport();
  const position = useAnchoredPosition<HTMLDivElement>(trigger, {
    enabled: open,
    placement: "below",
    align: "start",
    flip: true,
    subscribeContentClearance: mobileViewport.subscribeContentBottomClearance,
  });
  useOverlay(open, {
    kind: "transient",
    onDismiss: () => setOpen(false),
    inside: () => [position.ref.current, trigger.current],
    returnFocus: true,
    returnFocusTo: () => trigger.current ? { element: trigger.current, preventScroll: true } : null,
    tabContinuation: () => position.ref.current,
  });
  const focused = useRef(false);
  useEffect(() => {
    if (!open) { focused.current = false; return; }
    if (!position.placed || focused.current) return;
    const frame = requestAnimationFrame(() => {
      const target = position.ref.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]');
      if (target) { target.focus({ preventScroll: true }); focused.current = true; }
    });
    return () => cancelAnimationFrame(frame);
  }, [open, position.placed, position.ref]);
  useEffect(() => {
    if (!open) return;
    const composer = trigger.current?.closest("[data-selection-composer]");
    const close = () => setOpen(false);
    composer?.addEventListener("scroll", close, { passive: true });
    return () => composer?.removeEventListener("scroll", close);
  }, [open]);

  return <div className={styles.highlightControl}>
    <HighlightButton selected={selected} persisted={persisted} disabledReason={disabledReason} busy={busy} onClick={() => onSelect(selected)} />
    <Button ref={trigger} iconOnly className={styles.selectionIcon}
        aria-label="choose highlight colour" aria-expanded={open} aria-controls={open ? id : undefined}
        aria-disabled={disabledReason !== null || undefined}
        aria-describedby={disabledReason ? `${id}-disclosure-reason` : undefined}
        tooltip={{ text: disabledReason ? `choose highlight colour. ${disabledReason}` : "choose highlight colour" }}
        onClick={() => setOpen(!open)} icon={<ChevronDown size={16} />}
    />
    {disabledReason ? <span id={`${id}-disclosure-reason`} className="sr-only">{disabledReason}</span> : null}
    {open && container ? createPortal(
      <div id={id} ref={position.ref} className={styles.colourPopover} style={{ ...position.style, maxBlockSize: "var(--anchored-max-height)" }}>
        <Colours selected={selected} persisted={persisted} disabledReason={disabledReason}
          onSelect={(color) => { setOpen(false); onSelect(color); }} />
      </div>,
      container,
    ) : null}
  </div>;
}
