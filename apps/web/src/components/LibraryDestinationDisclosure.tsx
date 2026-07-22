"use client";

import { useId, useRef } from "react";
import { ChevronDown } from "lucide-react";
import LibraryDestinationPicker, {
  type LibraryDestinationPickerProps,
} from "@/components/LibraryDestinationPicker";
import { useContainingModalLayer } from "@/lib/ui/useModalLayer";
import { useEscapeKey } from "@/lib/ui/useEscapeKey";
import styles from "./LibraryDestinationDisclosure.module.css";

type LibraryDestinationDisclosureProps = Omit<
  LibraryDestinationPickerProps,
  "presentation" | "label"
> & {
  label: string;
  emptySummary?: string;
  open: boolean;
  onOpenChange(open: boolean): void;
};

export default function LibraryDestinationDisclosure({
  label,
  emptySummary = "My Library only",
  open,
  onOpenChange,
  selected,
  onChange,
  interaction,
  onCreateDestination,
}: LibraryDestinationDisclosureProps) {
  const contentId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const modalToken = useContainingModalLayer();

  function closeAndRestoreFocus() {
    if (interaction.kind === "Creating") return;
    onOpenChange(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  useEscapeKey(open, closeAndRestoreFocus, {
    layer: "transient",
    modalToken,
  });

  const summary =
    selected.length === 0
      ? emptySummary
      : selected.map((destination) => destination.name).join(", ");
  const triggerDisabled =
    interaction.kind === "Creating" ||
    (interaction.kind === "Disabled" && !open);

  return (
    <div className={styles.root}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        aria-expanded={open}
        aria-controls={contentId}
        disabled={triggerDisabled}
        onClick={() => onOpenChange(!open)}
      >
        <span className={styles.label}>{label}</span>
        <span className={styles.summary}>{summary}</span>
        <span className={styles.action}>{open ? "Close" : "Change"}</span>
        <ChevronDown
          size={15}
          aria-hidden="true"
          data-open={open || undefined}
        />
      </button>
      {open ? (
        <div id={contentId} className={styles.content}>
          <LibraryDestinationPicker
            selected={selected}
            onChange={onChange}
            presentation={{
              kind: "DisclosureContent",
              onRequestClose: closeAndRestoreFocus,
            }}
            label={label}
            interaction={interaction}
            onCreateDestination={onCreateDestination}
          />
        </div>
      ) : null}
    </div>
  );
}
