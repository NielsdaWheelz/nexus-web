"use client";

import { GitBranch, LocateFixed, X } from "lucide-react";
import Button from "@/components/ui/Button";
import { truncateText } from "@/lib/conversations/display";
import type { BranchDraft } from "@/lib/conversations/types";
import styles from "./BranchComposerHeader.module.css";

export default function BranchComposerHeader({
  branchDraft,
  onCancel,
  onJumpToParent,
}: {
  branchDraft: BranchDraft;
  onCancel: () => void;
  onJumpToParent?: (messageId: string) => void;
}) {
  const selectedQuote =
    branchDraft.anchor.kind === "assistant_selection" ? branchDraft.anchor.exact : null;

  return (
    <section className={styles.header} aria-label="Fork reply">
      <div className={styles.iconBox} aria-hidden="true">
        <GitBranch size={16} />
      </div>

      <div className={styles.copy}>
        <div className={styles.topLine}>
          <span className={styles.mode}>Fork reply</span>
          <span className={styles.parentLabel}>
            Parent message {branchDraft.parentMessageSeq}
          </span>
        </div>

        <p className={styles.preview}>
          {truncateText(branchDraft.parentMessagePreview, 180)}
        </p>

        {selectedQuote ? (
          <blockquote className={styles.quote}>
            {truncateText(selectedQuote, 220)}
          </blockquote>
        ) : null}
      </div>

      <div className={styles.actions}>
        {onJumpToParent ? (
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            onClick={() => onJumpToParent(branchDraft.parentMessageId)}
            aria-label="Jump to parent message"
            title="Jump to parent message"
          >
            <LocateFixed size={15} aria-hidden="true" />
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          onClick={onCancel}
          aria-label="Cancel branch reply"
          title="Cancel branch reply"
        >
          <X size={16} aria-hidden="true" />
        </Button>
      </div>
    </section>
  );
}
