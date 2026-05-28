"use client";

import Chip from "@/components/ui/Chip";

interface Props {
  label?: string;
  onDismiss: () => void;
}

export default function ReaderTargetDismissChip({
  label = "Focused",
  onDismiss,
}: Props) {
  return (
    <div
      style={{
        position: "absolute",
        top: "var(--space-3)",
        right: "var(--space-3)",
        zIndex: 5,
      }}
    >
      <Chip size="md" selected removable onRemove={onDismiss}>
        {label}
      </Chip>
    </div>
  );
}
