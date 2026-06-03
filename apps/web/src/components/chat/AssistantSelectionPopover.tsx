"use client";

import { GitBranch } from "lucide-react";
import Button from "@/components/ui/Button";
import FloatingActionSurface from "@/components/ui/FloatingActionSurface";
import type { AssistantSelectionBranchSelection } from "./useAssistantSelectionBranch";

export default function AssistantSelectionPopover({
  selection,
  onBranch,
  onDismiss,
}: {
  selection: AssistantSelectionBranchSelection;
  onBranch: () => void;
  onDismiss: () => void;
}) {
  return (
    <FloatingActionSurface
      open
      anchor={selection.rect}
      strategy="text-selection"
      lineRects={selection.lineRects}
      role="group"
      label="Assistant answer selection"
      preservePointerSelection
      onDismiss={onDismiss}
    >
      <Button
        variant="secondary"
        size="sm"
        leadingIcon={<GitBranch size={14} aria-hidden="true" />}
        onClick={onBranch}
      >
        Fork from selection
      </Button>
    </FloatingActionSurface>
  );
}
