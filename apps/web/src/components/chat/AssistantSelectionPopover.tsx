"use client";

import { GitBranch } from "lucide-react";
import Button from "@/components/ui/Button";
import styles from "./AssistantSelectionPopover.module.css";

export interface AssistantSelectionDraft {
  exact: string;
  prefix: string | null;
  suffix: string | null;
  start_offset: number | null;
  end_offset: number | null;
  offset_status: "mapped" | "unmapped";
  client_selection_id: string;
  rect: { top: number; left: number };
}

export default function AssistantSelectionPopover({
  selection,
  onBranch,
}: {
  selection: AssistantSelectionDraft;
  onBranch: () => void;
}) {
  return (
    <div
      className={styles.popover}
      style={{
        top: selection.rect.top,
        left: selection.rect.left,
      }}
      role="dialog"
      aria-label="Assistant answer selection"
    >
      <Button
        variant="secondary"
        size="sm"
        leadingIcon={<GitBranch size={14} aria-hidden="true" />}
        onClick={onBranch}
      >
        Branch from selection
      </Button>
    </div>
  );
}
