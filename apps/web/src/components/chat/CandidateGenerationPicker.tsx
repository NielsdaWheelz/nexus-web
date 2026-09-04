"use client";

import { useEffect, useState } from "react";
import Button from "@/components/ui/Button";
import GenerationSelectionPicker from "@/components/chat/GenerationSelectionPicker";
import { useGenerationCatalog } from "@/components/chat/useGenerationCatalog";
import type {
  GenerationSelectionSpec,
  RunSelectionOut,
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
  const [activated, setActivated] = useState(false);
  const [open, setOpen] = useState(false);
  const { catalog, loading, refreshing, error, retry } = useGenerationCatalog({
    enabled: activated,
    pickerOpen: open,
  });
  const actionLabel = `${operation} with a different model`;

  useEffect(() => {
    if (openRequestVersion < 1) return;
    setActivated(true);
    setOpen(true);
  }, [openRequestVersion]);

  if (!activated) {
    return (
      <Button
        variant="ghost"
        size="sm"
        disabled={disabled}
        onClick={() => {
          setActivated(true);
          setOpen(true);
        }}
      >
        {actionLabel}
      </Button>
    );
  }

  if (catalog === null) {
    return (
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
    );
  }

  return (
    <GenerationSelectionPicker
      catalog={catalog}
      value={runSelection.selection}
      contextualSelection={runSelection}
      open={open}
      onOpenChange={setOpen}
      onConfirm={async (selection) => {
        const accepted = await onConfirm(
          selection,
          catalog.definition_revision,
        );
        if (!accepted) retry();
        return accepted;
      }}
      disabled={disabled}
      refreshing={refreshing}
      refreshError={error}
      onRetryRefresh={retry}
      writeAuthority="ReadOnly"
      label={actionLabel}
      triggerActionLabel={actionLabel}
    />
  );
}
