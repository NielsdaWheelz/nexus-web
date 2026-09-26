"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Button from "@/components/ui/Button";
import GenerationSelectionPicker from "@/components/chat/GenerationSelectionPicker";
import { useGenerationCatalog } from "@/components/chat/useGenerationCatalog";
import {
  selectableGenerationCandidate,
  selectionUnavailabilityMessage,
  type SelectionDraft,
} from "@/lib/conversations/generationSelection";
import {
  hasSelectableCandidate,
  type GenerationSelectionSpec,
  type RunSelectionOut,
} from "@/lib/conversations/generationCatalog";
import styles from "./CandidateGenerationPicker.module.css";

interface CandidateGenerationPickerProps {
  readonly operation: "Rerun" | "Regenerate";
  readonly runSelection: RunSelectionOut;
  readonly disabled?: boolean;
  readonly openRequestVersion?: number;
  readonly onConfirm: (
    selection: GenerationSelectionSpec,
    catalogDefinitionRevision: string,
  ) => Promise<boolean>;
}

export default function CandidateGenerationPicker({
  operation,
  runSelection,
  disabled = false,
  openRequestVersion = 0,
  onConfirm,
}: CandidateGenerationPickerProps) {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [draft, setDraft] = useState<SelectionDraft>({
    kind: "Selected",
    selection: runSelection.selection,
  });
  const pickerRef = useRef<HTMLDivElement>(null);
  const focusOnOpenRef = useRef(false);
  const appliedOpenRequestRef = useRef(openRequestVersion);
  const { catalog, loading, error, retry } = useGenerationCatalog({
    enabled: open,
  });
  const actionLabel = `${operation} with a different model`;

  useEffect(() => {
    if (appliedOpenRequestRef.current === openRequestVersion) return;
    appliedOpenRequestRef.current = openRequestVersion;
    setDraft({ kind: "Selected", selection: runSelection.selection });
    focusOnOpenRef.current = true;
    setOpen(true);
  }, [openRequestVersion, runSelection.selection]);

  useLayoutEffect(() => {
    if (!open || catalog === null || !focusOnOpenRef.current) return;
    pickerRef.current?.querySelector<HTMLElement>("select:not(:disabled)")?.focus();
    focusOnOpenRef.current = false;
  }, [catalog, open]);

  const candidate =
    catalog === null ? null : selectableGenerationCandidate(catalog, draft);
  const noSelectablePair = catalog !== null && !hasSelectableCandidate(catalog);

  return (
    <div className={styles.picker}>
      <Button
        variant="ghost"
        size="sm"
        disabled={disabled || submitting}
        aria-expanded={open}
        onClick={() => {
          setDraft({ kind: "Selected", selection: runSelection.selection });
          focusOnOpenRef.current = !open;
          setOpen(!open);
        }}
      >
        {open ? "Cancel model choice" : actionLabel}
      </Button>
      {open && catalog === null ? (
        <div className={styles.status} role="status">
          <span>
            {loading
              ? "Loading model availability…"
              : "Model availability could not be loaded."}
          </span>
          {!loading ? (
            <Button variant="secondary" size="sm" onClick={retry}>
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}
      {open && catalog !== null ? (
        <>
          <div
            ref={pickerRef}
            className={styles.controls}
            onFocusCapture={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) retry();
            }}
          >
            <GenerationSelectionPicker
              catalog={catalog}
              value={draft}
              onChange={setDraft}
              disabled={disabled || submitting}
            />
          </div>
          {noSelectablePair ? (
            <p className={styles.status} role="status">
              No model and thinking setting is currently available. <Button variant="ghost" size="sm" onClick={retry}>Retry</Button>
            </p>
          ) : draft.kind === "Selected" && candidate === null ? (
            <p className={styles.status} role="status">
              {selectionUnavailabilityMessage(catalog, draft.selection)}
            </p>
          ) : null}
          {error !== null ? (
            <div className={styles.status} role="status">
              Model availability could not be refreshed.
              <Button variant="ghost" size="sm" onClick={retry}>Retry</Button>
            </div>
          ) : null}
          <Button
            variant="secondary"
            size="sm"
            disabled={disabled || submitting || candidate === null}
            loading={submitting}
            onClick={async () => {
              if (candidate === null || submitting) return;
              setSubmitting(true);
              try {
                const accepted = await onConfirm(
                  candidate.selection,
                  catalog.definition_revision,
                );
                if (accepted) setOpen(false);
                else retry();
              } finally {
                setSubmitting(false);
              }
            }}
          >
            {operation} with this model
          </Button>
        </>
      ) : null}
    </div>
  );
}
