"use client";

import { useCallback, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import PickerSurface from "@/components/ui/PickerSurface";
import { choiceUnavailable, type ModelVariant, type SelectionEditor } from "@/lib/chat/selection";
import styles from "./EffortPicker.module.css";

/** One ordered effort dimension; the model control owns mode. */
export default function EffortPicker({
  variant,
  value,
  disabled,
  footer,
  onOpen,
  onChange,
}: {
  variant: ModelVariant | null;
  value: SelectionEditor;
  disabled: boolean;
  footer: ReactNode;
  onOpen(): void;
  onChange(key: string): void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const range = useRef<HTMLInputElement>(null);
  const focusReplacement = useRef(false);
  const id = useId();
  const choices = variant?.reasoning.filter((row) => row.chat_state.kind === "Selectable") ?? [];
  const currentKey = value.kind === "Selected" ? value.selection.reasoning : null;
  const current = variant?.reasoning.find((row) => row.key === currentKey) ?? null;
  const index = choices.findIndex((row) => row.key === currentKey);
  const label = current?.effort ?? (currentKey === null ? "choose effort" : "effort unavailable");
  const ladder = JSON.stringify(choices.map((row) => row.key));
  const setRange = useCallback((node: HTMLInputElement | null) => {
    if (node === null && range.current === document.activeElement) focusReplacement.current = true;
    range.current = node;
  }, []);
  useLayoutEffect(() => {
    if (!focusReplacement.current) return;
    focusReplacement.current = false;
    const content = panel.current;
    if (!open || !content || (document.activeElement !== document.body && !content.contains(document.activeElement))) return;
    (range.current ?? content).focus({ preventScroll: true });
  });
  const show = () => {
    if (disabled || open) return;
    setOpen(true);
    onOpen();
  };
  return (
    <div className={styles.root}>
      <button ref={trigger} type="button" className={styles.trigger} disabled={disabled}
        aria-label={`effort, ${label}`} aria-haspopup="dialog" aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => open ? setOpen(false) : show()}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            show();
          }
        }}>
        <svg width="19" height="17" viewBox="0 0 24 20" fill="none" aria-hidden="true">
          <path d="M4 15a8 8 0 0 1 16 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          {index >= 0 && choices.length > 1 ? (
            <path d="M12 15V8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
              className={styles.needle}
              style={{ transform: `rotate(${-90 + index / (choices.length - 1) * 180}deg)` }} />
          ) : null}
          <circle cx="12" cy="15" r="1.5" fill="currentColor" />
        </svg>
        <span>{label}</span><ChevronDown size={13} aria-hidden="true" />
      </button>
      <PickerSurface active={open} onClose={() => setOpen(false)} anchor={() => trigger.current}
        title="effort" panelId={id} placement="above" className={styles.surface}
        initialFocus={(surface) => surface.querySelector<HTMLElement>("input[type=range]:not(:disabled), [data-effort-choice]:not(:disabled)") ?? surface}>
        <div ref={panel} className={styles.panel} role="group" aria-label="effort" tabIndex={-1}>
          <div className={styles.header}>
            <p className={styles.current}>{label}</p>
          </div>
          {current && choiceUnavailable(current) ? (
            <p className={styles.reason}>{choiceUnavailable(current)}</p>
          ) : null}
          {index >= 0 ? choices.length === 1 ? (
            <p className={styles.reason}>fixed effort</p>
          ) : (
            <div className={styles.rail}>
              <input key={ladder} ref={setRange} type="range" min={0} max={choices.length - 1} step={1}
                value={index} aria-label="effort" aria-valuetext={choices[index].effort}
                disabled={disabled}
                onChange={(event) => {
                  const choice = choices[Number(event.currentTarget.value)];
                  if (choice) onChange(choice.key);
                }} />
              <div className={styles.stops} aria-hidden="true">
                {choices.map((choice) => <span key={choice.key}>{choice.effort}</span>)}
              </div>
            </div>
          ) : choices.length > 0 ? (
            <div className={styles.choices} aria-label="choose effort">
              {choices.map((choice) => (
                <button type="button" data-effort-choice="true" key={choice.key} disabled={disabled}
                  onClick={() => {
                    focusReplacement.current = panel.current?.contains(document.activeElement) === true;
                    onChange(choice.key);
                  }}>{choice.effort}</button>
              ))}
            </div>
          ) : (
            <p className={styles.reason}>
              {variant ? choiceUnavailable(variant.reasoning[0]) ?? "effort unavailable" : "choose model to set effort"}
            </p>
          )}
          {footer}
        </div>
      </PickerSurface>
    </div>
  );
}
