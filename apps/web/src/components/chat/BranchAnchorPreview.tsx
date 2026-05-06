"use client";

import { GitBranch, X } from "lucide-react";
import Button from "@/components/ui/Button";
import { truncateText } from "@/lib/conversations/display";
import type { BranchDraft } from "@/lib/conversations/types";
import styles from "./BranchAnchorPreview.module.css";

export default function BranchAnchorPreview({
  draft,
  onRemove,
}: {
  draft: BranchDraft;
  onRemove: () => void;
}) {
  const anchorText =
    draft.anchor.kind === "assistant_selection"
      ? draft.anchor.exact
      : draft.parentMessagePreview;

  return (
    <section className={styles.preview} aria-label="Branch reply anchor">
      <GitBranch size={15} aria-hidden="true" />
      <div className={styles.copy}>
        <div className={styles.label}>
          Replying from assistant message #{draft.parentMessageSeq}
        </div>
        <blockquote className={styles.quote}>
          {truncateText(anchorText, 180)}
        </blockquote>
      </div>
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        onClick={onRemove}
        aria-label="Remove branch reply anchor"
      >
        <X size={14} aria-hidden="true" />
      </Button>
    </section>
  );
}
