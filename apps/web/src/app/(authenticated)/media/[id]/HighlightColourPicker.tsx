"use client";

import { Fragment, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Highlighter } from "lucide-react";
import Button from "@/components/ui/Button";
import Tooltip from "@/components/ui/Tooltip";
import type { HighlightColor } from "@/lib/documentReader/model";
import { useMobileViewport } from "@/lib/mobileShell/viewport";
import { useOverlay, useOverlayContainer } from "@/lib/ui/overlay";
import { useAnchoredPosition } from "@/lib/ui/useAnchoredPosition";
import styles from "./media.module.css";

const COLOURS: readonly HighlightColor[] = ["yellow", "green", "blue", "pink", "purple"];

export function Colours({ selected, onSelect, disabledReason = null, persisted = true }: {
  readonly selected: HighlightColor | null;
  readonly onSelect: (color: HighlightColor) => void;
  readonly disabledReason?: string | null;
  readonly persisted?: boolean;
}) {
  const id = useId();
  return <div className={styles.colours} role="group" aria-label="highlight colours">
    {COLOURS.map((color) => {
      const reason = disabledReason ?? (persisted && selected === color ? "this colour is already applied." : null);
      const label = `${color} highlight`;
      const reasonId = `${id}-${color}`;
      return <Fragment key={color}><Tooltip text={reason ? `${label}. ${reason}` : label} renderTrigger={(help) => (
        <button {...help} type="button" className={styles.colour} aria-label={label}
          aria-describedby={help["aria-describedby"] ?? (reason ? reasonId : undefined)}
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

/** A direct highlight command beside a transient choice; neither owns the note editor. */
export default function HighlightColourPicker({ selected, persisted, disabledReason, onSelect }: {
  readonly selected: HighlightColor;
  readonly persisted: boolean;
  readonly disabledReason: string | null;
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

  const label = persisted ? `highlighted ${selected}` : "highlight yellow";
  const reason = disabledReason ?? (persisted ? "this colour is already applied. choose another colour to change it." : null);
  return <div className={styles.highlightControl}>
    <Tooltip text={reason ? `${label}. ${reason}` : label} renderTrigger={(help) => (
      <Button {...help} variant="ghost" size="sm" iconOnly className={styles.selectionIcon}
        aria-label={label} aria-disabled={reason !== null || undefined}
        aria-describedby={help["aria-describedby"] ?? (reason ? `${id}-primary-reason` : undefined)}
        onClick={(event) => { if (reason) event.preventDefault(); else onSelect(selected); }}>
        <Highlighter size={16} aria-hidden="true" />
        <span className={styles.highlightColour} style={{ background: `var(--highlight-${selected})` }} aria-hidden="true" />
      </Button>
    )} />
    {reason ? <span id={`${id}-primary-reason`} className="sr-only">{reason}</span> : null}
    <Tooltip text={disabledReason ? `choose highlight colour. ${disabledReason}` : "choose highlight colour"} renderTrigger={(help) => (
      <Button {...help} ref={(node) => { help.ref(node); trigger.current = node; }}
        variant="ghost" size="sm" iconOnly className={styles.selectionIcon}
        aria-label="choose highlight colour" aria-expanded={open} aria-controls={open ? id : undefined}
        aria-disabled={disabledReason !== null || undefined}
        aria-describedby={help["aria-describedby"] ?? (disabledReason ? `${id}-disclosure-reason` : undefined)}
        onClick={(event) => { if (disabledReason) event.preventDefault(); else setOpen(!open); }}>
        <ChevronDown size={16} aria-hidden="true" />
      </Button>
    )} />
    {disabledReason ? <span id={`${id}-disclosure-reason`} className="sr-only">{disabledReason}</span> : null}
    {open && container ? createPortal(
      <div id={id} ref={position.ref} className={styles.colourPopover} style={{ ...position.style, maxBlockSize: "var(--anchored-max-height)" }} data-selection-composer="true">
        <Colours selected={selected} persisted={persisted} disabledReason={disabledReason}
          onSelect={(color) => { setOpen(false); onSelect(color); }} />
      </div>,
      container,
    ) : null}
  </div>;
}
