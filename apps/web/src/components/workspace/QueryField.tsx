"use client";

import { useCallback, useId, useLayoutEffect, useRef, type ComponentProps, type ReactNode, type Ref } from "react";
import * as Icon from "@/lib/ui/icons";
import { Field } from "@/components/feedback/Fact";
import type { Line, Verbs } from "@/components/feedback/stage";
import Button from "@/components/ui/Button";
import styles from "./QueryField.module.css";

/** The bare query row. Its caller owns the query and key semantics. */
export default function QueryField({ input, inputRef, applied, onClear, parts, notice, onClose }: {
  readonly input: Omit<ComponentProps<"input">, "value" | "ref"> & { readonly value: string };
  readonly inputRef?: Ref<HTMLInputElement>;
  readonly applied: string;
  readonly onClear: () => void;
  readonly parts?: ReactNode;
  readonly notice: { readonly kind: "Refused" | "Ready"; readonly line: Line; readonly verbs?: Verbs } | null;
  readonly onClose: (() => void) | null;
}) {
  const id = useId();
  const element = useRef<HTMLInputElement>(null);
  const noticeFocus = useRef(false);
  useLayoutEffect(() => {
    if (notice !== null || !noticeFocus.current) return;
    noticeFocus.current = false;
    if (document.activeElement === document.body) element.current?.focus({ preventScroll: true });
  }, [notice]);
  const setInput = useCallback((node: HTMLInputElement | null) => {
    element.current = node;
    if (typeof inputRef === "function") inputRef(node);
    else if (inputRef) inputRef.current = node;
  }, [inputRef]);
  const description = [input["aria-describedby"], notice ? id : null].filter(Boolean).join(" ") || undefined;
  return <div className={styles.field} data-pane-query-field="true">
    <div className={styles.row}>
      <Icon.Search size={16} aria-hidden="true" className={styles.search} />
      <div className={styles.entry}>
        <input {...input} ref={setInput} className={[styles.input, input.className].filter(Boolean).join(" ")}
          aria-describedby={description} aria-invalid={notice?.kind === "Refused" || input["aria-invalid"] || undefined} />
        <span className={styles.clearSlot}>{input.value || applied ? <Button iconOnly icon={<Icon.Dismiss />} aria-label="clear text"
          disabled={input.disabled} onClick={() => { onClear(); element.current?.focus({ preventScroll: true }); }} /> : null}</span>
      </div>
      {parts}
      {onClose ? <Button onClick={onClose}>close</Button> : null}
    </div>
    {notice ? <div onFocusCapture={() => { noticeFocus.current = true; }} onBlurCapture={event => {
      if (event.relatedTarget && event.relatedTarget !== document.body && !event.currentTarget.contains(event.relatedTarget)) noticeFocus.current = false;
    }}><Field id={id} line={notice.line} verbs={notice.verbs} /></div> : null}
  </div>;
}
